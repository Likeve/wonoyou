import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api/, /^\/signal/],
  }),
);

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // 兼容非 JSON 推送。
  }
  const peer = payload.data?.peer;
  const badge = Number(payload.badge);
  event.waitUntil(
    (async () => {
      if (Number.isInteger(badge) && badge >= 0 && "setAppBadge" in navigator) {
        try {
          await navigator.setAppBadge(badge);
        } catch {
          // 环境不支持图标角标时忽略。
        }
      }
      return self.registration.showNotification(payload.title || "INOU", {
        body: payload.body || "你收到一条新消息",
        icon: "/icon-192.png",
        tag: peer ? "inou-" + peer : "inou-message",
        data: payload.data || {},
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const peer = event.notification.data?.peer;
  const url = new URL(self.location.origin + "/");
  if (peer) url.searchParams.set("peer", peer);
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clients) {
        if ("focus" in client) {
          try {
            await client.navigate(url.href);
          } catch {
            // 某些环境不支持 navigate，聚焦已有窗口即可。
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
