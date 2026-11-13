import webpush from "web-push";

export function vapidKeys() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT || "mailto:q1b2kb@qq.com",
  };
}

export function pushFailure(error) {
  const status = Number(error?.statusCode);
  return {
    sent: false,
    // 404/410 mean the push endpoint is permanently invalid. Temporary
    // upstream failures must not erase a subscription that can recover.
    expired: status === 404 || status === 410,
  };
}

export async function sendPush(subscription, payload) {
  const keys = vapidKeys();
  if (!keys || !subscription?.endpoint || !subscription?.keys?.p256dh)
    return { sent: false, expired: false };
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      JSON.stringify(payload),
    );
    return { sent: true, expired: false };
  } catch (error) {
    return pushFailure(error);
  }
}
