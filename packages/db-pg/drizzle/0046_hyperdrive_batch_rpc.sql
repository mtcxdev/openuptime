CREATE OR REPLACE FUNCTION public.openuptime_record_check(
  p_monitor_id uuid,
  p_completed_at timestamptz,
  p_ok boolean,
  p_latency_ms integer,
  p_degraded boolean,
  p_generation integer,
  p_expected_revision integer,
  p_expected_hb_version integer,
  p_has_domain_expiry boolean,
  p_domain_expiry jsonb,
  p_expected_target text,
  p_expected_warn_days integer,
  p_results jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  cur public.monitor%ROWTYPE;
  v_clock timestamptz;
  v_latest timestamptz;
  v_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_last_rev integer;
  v_last_state text;
  v_last_valid timestamptz;
  v_maint_until timestamptz;
  v_in_maint boolean := false;
  v_duration_ms bigint;
  v_obs_state text;
  v_successes integer;
  v_recovery_ready boolean;
  v_failures integer;
  v_slow boolean;
  v_slow_count integer;
  v_next_status public.monitor_status;
  v_going_down boolean;
  v_recovering boolean;
  v_wants_slow boolean;
  v_parent_down boolean := false;
  v_slow_trips boolean;
  v_slow_clears boolean;
  v_final_slow integer;
  v_opens_outage boolean;
  v_check_late_open boolean;
  v_pending boolean;
BEGIN
  SELECT * INTO cur FROM public.monitor WHERE id = p_monitor_id FOR UPDATE;
  IF NOT FOUND OR cur.paused OR cur.coverage_revision <> p_expected_revision THEN
    RETURN jsonb_build_object('accepted', false);
  END IF;
  IF p_generation IS NOT NULL AND (p_generation <= 0 OR p_generation > cur.run_generation OR p_generation <= cur.coverage_generation) THEN
    RETURN jsonb_build_object('accepted', false);
  END IF;
  IF cur.type = 'heartbeat' AND cur.coverage_heartbeat_version <> p_expected_hb_version THEN
    RETURN jsonb_build_object('accepted', false);
  END IF;
  IF p_has_domain_expiry AND (cur.type <> 'domain' OR cur.target <> p_expected_target OR cur.domain_expiry_warn_days <> p_expected_warn_days) THEN
    RETURN jsonb_build_object('accepted', false);
  END IF;

  v_clock := date_trunc('milliseconds', clock_timestamp());
  UPDATE public.monitor_observation o
  SET observed_at = v_clock,
      valid_until = CASE WHEN o.valid_until IS NULL THEN NULL ELSE o.valid_until - (o.observed_at - v_clock) END
  WHERE o.monitor_id = cur.id AND o.observed_at > v_clock;

  SELECT max(observed_at) INTO v_latest FROM public.monitor_observation WHERE monitor_id = cur.id;
  v_at := least(p_completed_at, v_clock);
  IF v_latest IS NOT NULL THEN
    v_at := greatest(v_at, v_latest);
  END IF;

  IF cur.type = 'heartbeat' AND NOT p_ok THEN
    SELECT revision, state, valid_until INTO v_last_rev, v_last_state, v_last_valid
    FROM public.monitor_observation
    WHERE monitor_id = cur.id
    ORDER BY observed_at DESC, id DESC
    LIMIT 1;
    IF FOUND AND v_last_rev = cur.coverage_revision AND v_last_state IN ('up', 'degraded')
       AND v_last_valid IS NOT NULL AND v_last_valid > v_at THEN
      RETURN jsonb_build_object('accepted', false);
    END IF;
  END IF;

  SELECT
    max(ends_at) FILTER (WHERE starts_at <= v_at AND ends_at > v_at),
    coalesce(bool_or(starts_at <= v_now AND ends_at >= v_now), false)
  INTO v_maint_until, v_in_maint
  FROM public.maintenance_window
  WHERE organization_id = cur.organization_id
    AND (project_id IS NULL OR project_id = cur.project_id)
    AND ends_at >= least(v_at, v_now)
    AND starts_at <= greatest(v_at, v_now)
    AND (cardinality(monitor_ids) = 0 OR cur.id = ANY(monitor_ids));

  v_duration_ms := CASE WHEN cur.type = 'heartbeat'
    THEN (cur.interval_sec::bigint + cur.grace_sec::bigint) * 1000
    ELSE cur.interval_sec::bigint * 1000 + cur.timeout_ms::bigint + 60000
  END;
  v_obs_state := CASE
    WHEN NOT p_ok THEN 'down'
    WHEN p_degraded OR (p_latency_ms IS NOT NULL AND p_latency_ms > cur.slow_threshold_ms) THEN 'degraded'
    ELSE 'up'
  END;

  INSERT INTO public.monitor_observation (monitor_id, observed_at, state, valid_until, maintenance_until, revision, generation, interval_sec, grace_sec, timeout_ms)
  VALUES (cur.id, v_at, v_obs_state, v_at + (v_duration_ms * interval '1 millisecond'), v_maint_until, cur.coverage_revision, p_generation, cur.interval_sec, cur.grace_sec, cur.timeout_ms);

  IF jsonb_array_length(p_results) > 0 THEN
    INSERT INTO public.check_result (monitor_id, region, ok, status_code, latency_ms, error)
    SELECT cur.id,
           coalesce(r->>'region', 'auto'),
           (r->>'ok')::boolean,
           (r->>'statusCode')::integer,
           (r->>'latencyMs')::integer,
           r->>'error'
    FROM jsonb_array_elements(p_results) AS r;

    INSERT INTO public.check_rollup (monitor_id, bucket, total, ok, latency_sum, latency_n)
    VALUES (cur.id, date_trunc('hour', v_now), 1, CASE WHEN p_ok THEN 1 ELSE 0 END, coalesce(p_latency_ms, 0), CASE WHEN p_latency_ms IS NULL THEN 0 ELSE 1 END)
    ON CONFLICT (monitor_id, bucket) DO UPDATE SET
      total = public.check_rollup.total + 1,
      ok = public.check_rollup.ok + EXCLUDED.ok,
      latency_sum = public.check_rollup.latency_sum + EXCLUDED.latency_sum,
      latency_n = public.check_rollup.latency_n + EXCLUDED.latency_n;
  END IF;

  v_successes := CASE
    WHEN p_ok AND cur.status = 'down' THEN least(cur.consecutive_successes + 1, cur.recovery_threshold)
    WHEN NOT p_ok AND cur.consecutive_successes <> 0 THEN 0
    ELSE cur.consecutive_successes
  END;
  v_recovery_ready := v_successes >= cur.recovery_threshold;

  IF v_in_maint AND NOT p_ok THEN
    UPDATE public.monitor SET
      coverage_generation = coalesce(p_generation, coverage_generation),
      domain_expiry = CASE WHEN p_has_domain_expiry THEN p_domain_expiry ELSE domain_expiry END,
      consecutive_successes = v_successes,
      last_checked_at = v_now,
      next_check_at = CASE WHEN type = 'heartbeat' THEN v_now + make_interval(secs => interval_sec + grace_sec) ELSE next_check_at END
    WHERE id = cur.id;
    RETURN jsonb_build_object('accepted', true, 'suppressedMaintenance', true);
  END IF;

  v_failures := CASE WHEN p_ok THEN 0 ELSE cur.consecutive_failures + 1 END;
  v_slow := cur.type <> 'domain' AND p_ok AND p_latency_ms IS NOT NULL AND p_latency_ms > cur.slow_threshold_ms;
  v_slow_count := CASE WHEN NOT p_ok THEN cur.consecutive_slow WHEN v_slow THEN cur.consecutive_slow + 1 ELSE 0 END;
  v_next_status := CASE
    WHEN p_ok THEN
      CASE WHEN cur.status = 'down' AND NOT v_recovery_ready THEN 'down'::public.monitor_status
           WHEN v_slow OR p_degraded THEN 'degraded'::public.monitor_status
           ELSE 'up'::public.monitor_status END
    WHEN v_failures >= cur.failure_threshold THEN 'down'::public.monitor_status
    WHEN cur.type = 'domain' THEN 'degraded'::public.monitor_status
    ELSE cur.status
  END;
  v_going_down := v_next_status = 'down' AND cur.status <> 'down';
  v_recovering := p_ok AND cur.status = 'down' AND v_recovery_ready;
  v_wants_slow := v_next_status <> 'down' AND NOT p_degraded AND v_slow AND cur.slow_alert_after > 0 AND v_slow_count = cur.slow_alert_after;

  IF cur.depends_on_monitor_id IS NOT NULL AND (v_going_down OR v_wants_slow OR p_degraded OR (NOT p_ok AND v_next_status = 'down')) THEN
    SELECT coalesce(type <> 'domain' AND status = 'down', false) INTO v_parent_down
    FROM public.monitor WHERE id = cur.depends_on_monitor_id;
    v_parent_down := coalesce(v_parent_down, false);
  END IF;

  v_slow_trips := v_wants_slow AND NOT v_in_maint AND NOT v_parent_down;
  v_slow_clears := p_ok AND NOT v_slow AND cur.consecutive_slow > 0;
  v_final_slow := CASE WHEN v_next_status = 'down' THEN 0 ELSE v_slow_count END;
  v_opens_outage := v_going_down AND NOT v_parent_down;
  v_check_late_open := NOT p_ok AND NOT v_going_down AND v_next_status = 'down' AND cur.status = 'down' AND cur.depends_on_monitor_id IS NOT NULL AND NOT v_parent_down;
  v_pending := v_opens_outage OR v_recovering OR v_slow_trips OR v_slow_clears;

  UPDATE public.monitor SET
    coverage_generation = coalesce(p_generation, coverage_generation),
    domain_expiry = CASE WHEN p_has_domain_expiry THEN p_domain_expiry ELSE domain_expiry END,
    consecutive_successes = v_successes,
    consecutive_failures = v_failures,
    status = CASE WHEN v_pending THEN status ELSE v_next_status END,
    status_changed_at = CASE WHEN NOT v_pending AND cur.status IS DISTINCT FROM v_next_status THEN v_now ELSE status_changed_at END,
    consecutive_slow = CASE WHEN v_pending THEN consecutive_slow ELSE v_final_slow END,
    last_checked_at = CASE WHEN type = 'heartbeat' THEN last_checked_at ELSE v_now END,
    next_check_at = CASE WHEN type = 'heartbeat' THEN v_now + make_interval(secs => interval_sec + grace_sec) ELSE next_check_at END
  WHERE id = cur.id;

  RETURN jsonb_build_object(
    'accepted', true,
    'suppressedMaintenance', false,
    'inMaintenance', v_in_maint,
    'parentDown', v_parent_down,
    'wantsSlowIncident', v_wants_slow,
    'goingDown', v_going_down,
    'recovering', v_recovering,
    'opensOutage', v_opens_outage,
    'slowTrips', v_slow_trips,
    'slowClears', v_slow_clears,
    'checkLateOpen', v_check_late_open,
    'pending', v_pending,
    'nextStatus', v_next_status::text,
    'finalSlow', v_final_slow
  );
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.openuptime_record_heartbeat(
  p_monitor_id uuid,
  p_completed_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  cur public.monitor%ROWTYPE;
  updated public.monitor%ROWTYPE;
  v_clock timestamptz;
  v_latest timestamptz;
  v_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_maint_until timestamptz;
  v_duration_ms bigint;
BEGIN
  SELECT * INTO cur FROM public.monitor WHERE id = p_monitor_id FOR UPDATE;
  IF NOT FOUND OR cur.paused OR cur.type <> 'heartbeat' THEN
    RETURN NULL;
  END IF;

  v_clock := date_trunc('milliseconds', clock_timestamp());
  UPDATE public.monitor_observation o
  SET observed_at = v_clock,
      valid_until = CASE WHEN o.valid_until IS NULL THEN NULL ELSE o.valid_until - (o.observed_at - v_clock) END
  WHERE o.monitor_id = cur.id AND o.observed_at > v_clock;

  SELECT max(observed_at) INTO v_latest FROM public.monitor_observation WHERE monitor_id = cur.id;
  v_at := least(p_completed_at, v_clock);
  IF v_latest IS NOT NULL THEN
    v_at := greatest(v_at, v_latest);
  END IF;

  SELECT max(ends_at) INTO v_maint_until
  FROM public.maintenance_window
  WHERE organization_id = cur.organization_id
    AND (project_id IS NULL OR project_id = cur.project_id)
    AND starts_at <= v_at AND ends_at > v_at
    AND (cardinality(monitor_ids) = 0 OR cur.id = ANY(monitor_ids));

  v_duration_ms := (cur.interval_sec::bigint + cur.grace_sec::bigint) * 1000;
  INSERT INTO public.monitor_observation (monitor_id, observed_at, state, valid_until, maintenance_until, revision, generation, interval_sec, grace_sec, timeout_ms)
  VALUES (cur.id, v_at, 'up', v_at + (v_duration_ms * interval '1 millisecond'), v_maint_until, cur.coverage_revision, NULL, cur.interval_sec, cur.grace_sec, cur.timeout_ms);

  INSERT INTO public.check_result (monitor_id, region, ok)
  VALUES (cur.id, 'auto', true);

  INSERT INTO public.check_rollup (monitor_id, bucket, total, ok, latency_sum, latency_n)
  VALUES (cur.id, date_trunc('hour', v_now), 1, 1, 0, 0)
  ON CONFLICT (monitor_id, bucket) DO UPDATE SET
    total = public.check_rollup.total + 1,
    ok = public.check_rollup.ok + 1;

  UPDATE public.monitor SET
    coverage_heartbeat_version = cur.coverage_heartbeat_version + 1,
    consecutive_successes = least(cur.consecutive_successes + 1, cur.recovery_threshold),
    consecutive_failures = 0,
    last_checked_at = v_at,
    next_check_at = clock_timestamp() + make_interval(secs => cur.interval_sec + cur.grace_sec),
    status = CASE WHEN cur.status = 'down' THEN 'down'::public.monitor_status ELSE 'up'::public.monitor_status END,
    status_changed_at = CASE WHEN cur.status NOT IN ('down', 'up') THEN v_at ELSE cur.status_changed_at END
  WHERE id = cur.id
  RETURNING * INTO updated;

  RETURN jsonb_build_object(
    'status', updated.status::text,
    'consecutiveSuccesses', updated.consecutive_successes,
    'recoveryThreshold', updated.recovery_threshold,
    'intervalSec', updated.interval_sec,
    'graceSec', updated.grace_sec,
    'coverageHeartbeatVersion', updated.coverage_heartbeat_version,
    'lastCheckedAt', updated.last_checked_at,
    'nextCheckAt', updated.next_check_at
  );
END;
$$;
