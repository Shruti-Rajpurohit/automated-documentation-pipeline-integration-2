interface RunCompleteNotification {
  toEmail?: string | null;
  productName: string;
  title: string;
  status: string;
  sessionUrl: string;
}

function isDeliverableEmail(value: string): boolean {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  return !/(^|\.)localhost$/i.test(value.split("@")[1]);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

async function postJson(url: string, headers: HeadersInit, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Notification request failed with status ${response.status}.`);
}

export async function notifyRunComplete({
  toEmail,
  productName,
  title,
  status,
  sessionUrl,
}: RunCompleteNotification): Promise<void> {
  const recipient = toEmail && isDeliverableEmail(toEmail)
    ? toEmail
    : process.env.NOTIFICATION_EMAIL || "";
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATION_FROM_EMAIL;
  const errors: string[] = [];
  if (apiKey && isDeliverableEmail(recipient)) {
    try {
      if (!from) throw new Error("NOTIFICATION_FROM_EMAIL is required when RESEND_API_KEY is configured.");
      const safeProduct = escapeHtml(productName);
      const safeTitle = escapeHtml(title);
      const safeStatus = escapeHtml(status);
      const safeUrl = escapeHtml(sessionUrl);
      await postJson("https://api.resend.com/emails", {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      }, {
        from,
        to: [recipient],
        subject: `Docline run ${status}: ${productName}`,
        text: `${productName}: ${title}\nStatus: ${status}\nReview: ${sessionUrl}`,
        html: `<p><strong>${safeProduct}</strong>: ${safeTitle}</p><p>Status: ${safeStatus}</p><p><a href="${safeUrl}">Review session</a></p>`,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Email notification failed.");
    }
  }
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (slackUrl) {
    try {
      const parsedUrl = new URL(slackUrl);
      if (parsedUrl.protocol !== "https:") {
        throw new Error("SLACK_WEBHOOK_URL must use HTTPS.");
      }
      await postJson(slackUrl, { "content-type": "application/json" }, {
        text: `*${productName}* — ${title}\nStatus: *${status}* · <${sessionUrl}|Review session>`,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Slack notification failed.");
    }
  }
  if (errors.length > 0) throw new Error(errors.join(" "));
}
