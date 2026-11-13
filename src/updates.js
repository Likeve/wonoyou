// One build identifier is embedded in the app and emitted as an uncached manifest.
export const APP_VERSION = __APP_VERSION__;
export async function checkForUpdate(vault) {
  if (!navigator.onLine) throw Error("当前离线，请联网后检查更新");
  const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw Error("检查更新失败，请稍后重试");
  let remote;
  try { remote = await response.json(); } catch { throw Error("无法读取版本信息，请稍后重试"); }
  if (typeof remote.build !== "string") throw Error("版本信息无效，请稍后重试");
  if (remote.build === __BUILD_ID__) return false;
  await vault?.flush();
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration) {
    await registration.update();
    if (registration.installing) {
      const worker = registration.installing;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(Error("新版下载超时，请稍后重试")), 45000);
        const finish = (error) => { clearTimeout(timer); worker.removeEventListener("statechange", change); error ? reject(error) : resolve(); };
        const change = () => {
          if (worker.state === "installed" || worker.state === "activated") finish();
          else if (worker.state === "redundant") finish(Error("新版下载失败，请稍后重试"));
        };
        worker.addEventListener("statechange", change);
        change();
      });
    }
    if (registration.waiting) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener("controllerchange", change); reject(Error("版本切换超时，请重试")); }, 15000);
        const change = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", change); resolve(); };
        navigator.serviceWorker.addEventListener("controllerchange", change);
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      });
    }
  }
  location.reload();
  return true;
}
