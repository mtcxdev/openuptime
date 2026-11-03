import { afterEach, describe, expect, it, vi } from "vitest";
import { configureEmail, sendEmail, setMailTransport } from "./email";

const msg = { to: "a@example.com", subject: "s", html: "<p>x</p>", text: "x", headers: { "List-Unsubscribe": "<https://x/u>" } };

describe("sendEmail through the Cloudflare binding", () => {
  afterEach(() => { setMailTransport(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("passes custom headers along", async () => {
    const send = vi.fn(async (_m: Record<string, unknown>) => ({}));
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await sendEmail(msg);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ headers: msg.headers });
  });

  it("sends again without the headers when the binding refuses them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async (m: Record<string, unknown>) => { if (m.headers) throw new Error("unknown field headers"); return {}; });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await sendEmail(msg);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).not.toHaveProperty("headers");
  });

  it.each([["E_HEADER_NOT_ALLOWED", "message"], ["invalid_headers", "rejected"]])("recognises the header error code %s", async (code, message) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async (m: Record<string, unknown>) => { if (m.headers) throw Object.assign(new Error(message === "message" ? code : message), { code }); return {}; });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await sendEmail(msg);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).not.toHaveProperty("headers");
  });

  it("does not send a second time when the failure has nothing to do with the headers", async () => {
    const send = vi.fn(async () => { throw new Error("timeout while sending"); });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await expect(sendEmail(msg)).rejects.toThrow("timeout");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still fails when the message is refused without headers too", async () => {
    const send = vi.fn(async (m: Record<string, unknown>) => { throw new Error(m.headers ? "invalid headers" : "rejected"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await expect(sendEmail(msg)).rejects.toThrow("rejected");
    expect(send).toHaveBeenCalledTimes(2);
  });
});


describe("sendEmail through Brevo", () => {
  afterEach(() => { setMailTransport(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("sends transactional messages through the Brevo HTTPS API", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: "brevo-message-id" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    configureEmail({ BREVO_API_KEY: "test-brevo-key", EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);

    await sendEmail({ ...msg, fromName: "MTCX Status" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("api-key")).toBe("test-brevo-key");
    expect(JSON.parse(String(init.body))).toMatchObject({
      sender: { email: "alerts@example.com", name: "MTCX Status" },
      to: [{ email: "a@example.com" }],
      subject: "s",
      htmlContent: "<p>x</p>",
      textContent: "x",
      headers: msg.headers,
    });
  });

  it("surfaces Brevo API failures without logging a false success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sender not verified", { status: 400 })));
    configureEmail({ BREVO_API_KEY: "test-brevo-key", EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);

    await expect(sendEmail(msg)).rejects.toThrow("Brevo email request failed (400)");
  });
});
