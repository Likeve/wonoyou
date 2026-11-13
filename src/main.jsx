import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Users,
  MessageCircle,
  ContactRound,
  UserRound,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  ShieldCheck,
  LockKeyhole,
  ArrowUpRight,
  Copy,
  X,
  ImagePlus,
  Smile,
  Send,
  Download,
  Upload,
  KeyRound,
  WifiOff,
  Check,
  Clock3,
  Trash2,
  UserPlus,
  LogOut,
  Smartphone,
  Link2,
  Bell,
  RefreshCw,
  ShieldBan,
  LoaderCircle,
  QrCode,
  ScanLine,
  Camera,
  CameraOff,
} from "lucide-react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { APP_VERSION, checkForUpdate } from "./updates";
import { registerSW } from "virtual:pwa-register";
import {
  hasVault,
  createVault,
  loadVault,
  deleteVault,
  exportArchive,
  readArchive,
  prepareImage,
  digest,
} from "./vault";
import { ChatEngine } from "./engine";
import {
  hasSupabase,
  currentSession,
  signIn,
  signUp,
  signOut,
  readableAuthError,
  generateRecoveryPhrase,
  requestRecovery,
} from "./auth";
import "./style.css";
const logo = (
  <span className="brand-mark">
    <MessageCircle size={25} strokeWidth={2.4} />
    <i />
    <i />
  </span>
);
const time = (t) =>
  new Date(t).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
const label = (c) => c.remark || c.name || "新朋友";
const formatId = (id) =>
  "INOU-" + String(id || "").toUpperCase().match(/.{1,4}/g).join("-");
const normalizeId = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
const genUsername = () => {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "inou-";
  for (const b of crypto.getRandomValues(new Uint8Array(6))) s += chars[b % chars.length];
  return s;
};
function Avatar({ name = "", id = "", large = false }) {
  return (
    <div
      className={"avatar " + (large ? "large" : "")}
      style={{
        "--avatar": `hsl(${parseInt(id.slice(0, 3) || "100", 16) % 360} 35% 87%)`,
      }}
    >
      {name.slice(0, 1) || <UserRound size={24} />}
    </div>
  );
}

const cameraError = (e) => {
  const name = e?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "没有摄像头权限。请到 iPhone「设置 → 隐私与安全性 → 相机」允许 Safari 或 INOU 访问后重试。";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "没有找到可用的摄像头。";
  if (name === "NotReadableError")
    return "摄像头正被其他应用占用，请稍后再试。";
  return (
    "无法启动摄像头（" +
    (name || e?.message || "未知错误") +
    "），请改用输入身份码。"
  );
};

function IdentityQR({ value }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let ok = true;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 4,
      width: 260,
      color: { dark: "#1f4d36", light: "#ffffff" },
    })
      .then((u) => ok && setUrl(u))
      .catch(() => {});
    return () => {
      ok = false;
    };
  }, [value]);
  return url ? (
    <img className="qr-code" src={url} alt="身份码二维码" />
  ) : (
    <div className="qr-placeholder">
      <LoaderCircle size={18} className="spin" /> 正在生成二维码…
    </div>
  );
}

function Scanner({ onResult, onCancel, stream }) {
  const videoRef = useRef(null),
    canvasRef = useRef(null),
    rafRef = useRef(0),
    doneRef = useRef(false),
    onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  useEffect(() => {
    if (!stream) return;
    let stopped = false;
    const stopStream = () => stream.getTracks().forEach((t) => t.stop());
    const video = videoRef.current;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.setAttribute("autoplay", "");
    video.srcObject = stream;
    // Best-effort play. iOS Safari can reject the play() promise if the frame
    // isn't ready yet; the RAF loop below waits for readyState.
    const ensurePlay = () => {
      if (stopped) return;
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    };
    video.addEventListener("loadedmetadata", ensurePlay, { once: true });
    video.addEventListener("canplay", ensurePlay, { once: true });
    ensurePlay();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (stopped || doneRef.current) return;
      if (video.readyState >= video.HAVE_ENOUGH_DATA) {
        const vw = video.videoWidth,
          vh = video.videoHeight;
        if (vw && vh) {
          const scale = Math.min(1, 720 / Math.max(vw, vh)),
            w = Math.max(1, Math.round(vw * scale)),
            h = Math.max(1, Math.round(vh * scale));
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
          if (code?.data) {
            doneRef.current = true;
            stopStream();
            onResultRef.current(code.data);
            return;
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      doneRef.current = true;
      cancelAnimationFrame(rafRef.current);
      stopStream();
    };
  }, [stream]);
  return (
    <div className="scanner">
      <div className="scanner-view">
        <video ref={videoRef} muted playsInline />
        <canvas ref={canvasRef} className="scanner-canvas" aria-hidden="true" />
        <i className="scanner-frame" />
      </div>
      <p className="muted center scan-hint">将对方二维码放入框内，识别后自动添加。</p>
      <button
        className="text-btn full"
        onClick={onCancel}
      >
        返回手动输入
      </button>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState("loading"),
    [authMode, setAuthMode] = useState("register"),
    [authError, setAuthError] = useState(""),
    [authNotice, setAuthNotice] = useState(""),
    [authBusy, setAuthBusy] = useState(false),
    [accountName, setAccountName] = useState(""),
    [username, setUsername] = useState(genUsername),
    [recoveryPhrase, setRecoveryPhrase] = useState(""),
    [ready, setReady] = useState("loading"),
    [bootNeedsReset, setBootNeedsReset] = useState(false),
    [vault, setVault] = useState(null),
    [view, setView] = useState("chats"),
    [selected, setSelected] = useState(null),
    [modal, setModal] = useState(null),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false),
    [version, render] = useState(0),
    [search, setSearch] = useState(""),
    [draft, setDraft] = useState(""),
    [scanning, setScanning] = useState(false),
    [scanStream, setScanStream] = useState(null),
    [scanError, setScanError] = useState(""),
    [preview, setPreview] = useState(null),
    [backupFile, setBackupFile] = useState(null),
    [update, setUpdate] = useState(null),
    [checkingUpdate, setCheckingUpdate] = useState(false),
    [notif, setNotif] = useState(""),
    [emoji, setEmoji] = useState(false);
  const engine = useRef(null),
    scanActive = useRef(false),
    userIdRef = useRef(""),
    bottom = useRef(null),
    scroll = useRef(null),
    fileInput = useRef(null),
    restoreInput = useRef(null),
    release = useRef(null),
    nearBottom = useRef(true),
    [newMessage, setNewMessage] = useState(false);
  const state = vault?.state,
    conversations = [...(state?.contacts || []), ...(state?.groups || [])],
    contact = conversations.find((c) => c.id === selected),
    messages = state?.messages.filter((m) => m.peer === selected) || [];
  const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    standalone =
      matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const flash = (text) => {
    setToast(text);
    setTimeout(() => setToast(""), 3500);
  };
  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message || "操作没有完成，请重试");
    } finally {
      setBusy(false);
    }
  };
  const vaultKeyFor = (uid) => (uid ? "vault:" + uid : "vault");
  const enterApp = async (uid = "") => {
    setError("");
    setBootNeedsReset(false);
    const storageKey = vaultKeyFor(uid);
    if (await hasVault(storageKey)) {
      try {
        await start(await loadVault(storageKey));
      } catch (e) {
        if (/版本过旧|已损坏/.test(e.message)) setBootNeedsReset(true);
        throw e;
      }
    } else setReady("create");
  };
  async function boot() {
    setError("");
    try {
      if (hasSupabase()) {
        const session = await currentSession();
        if (!session) {
          setAuth("signedOut");
          setReady("loading");
          return;
        }
        setAccountName(session.user?.user_metadata?.username || "");
        userIdRef.current = session.user?.id || "";
      }
      setAuth("signedIn");
      await enterApp(userIdRef.current);
    } catch (e) {
      setError(e.message || "无法使用本地存储");
      setReady("error");
    }
  }
  useEffect(() => {
    boot();
    registerSW({
      onNeedRefresh() { setUpdate(true); },
      // The explicit update action saves the vault and reloads this window.
      onNeedReload() {},
    });
  }, []);
  const start = async (v) => {
    if (navigator.locks) {
      let resolveReady;
      const ready = new Promise((r) => (resolveReady = r));
      navigator.locks.request("inou-active", { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolveReady(false);
          return;
        }
        resolveReady(true);
        return new Promise((r) => (release.current = r));
      });
      if (!(await ready))
        throw Error("INOU 已在另一个窗口打开，请先关闭那个窗口");
    }
    setVault(v);
    const e = new ChatEngine(
      v,
      () => render((n) => n + 1),
      (text) => setError(text),
    );
    engine.current = e;
    e.start().catch((e) => setError(e.message));
    navigator.storage?.persist?.().catch(() => {});
  };
  useEffect(() => {
    if (!vault) return;
    const visibility = () => {
      if (!document.hidden) engine.current?.tick().catch(() => {});
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [vault]);
  useEffect(() => {
    if (vault && selected && !document.hidden && nearBottom.current) {
      const c = [...vault.state.contacts, ...(vault.state.groups || [])].find((c) => c.id === selected);
      if (c) {
        c.lastRead = Date.now();
        vault.save().catch(() => {});
        render((n) => n + 1);
      }
    }
    if (nearBottom.current)
      bottom.current?.scrollIntoView({ behavior: "smooth" });
    else setNewMessage(true);
  }, [messages.length, selected]);
  const choose = (id) => {
    setSelected(id);
    setDraft(state.drafts[id] || "");
    nearBottom.current = true;
    setNewMessage(false);
    setEmoji(false);
    const c = conversations.find((c) => c.id === id);
    if (c) {
      c.lastRead = Date.now();
      vault.save().catch(() => {});
    }
    render((n) => n + 1);
  };
  useEffect(() => {
    if (!vault) return;
    engine.current?.pushPermission().then(setNotif).catch(() => setNotif("unsupported"));
  }, [vault, version]);
  useEffect(() => {
    if (!vault) return;
    const peer = new URLSearchParams(location.search).get("peer");
    if (peer && conversations.some((c) => c.id === peer)) {
      choose(peer);
      history.replaceState(null, "", location.pathname);
    }
  }, [vault, version]);
  useEffect(() => {
    if (!vault || !("setAppBadge" in navigator)) return;
    const unread = state.messages.filter(
      (m) =>
        m.sender !== state.identity.id &&
        m.time > (conversations.find((c) => c.id === m.peer)?.lastRead || 0),
    ).length;
    if (unread > 0) navigator.setAppBadge(unread).catch(() => {});
    else if ("clearAppBadge" in navigator)
      navigator.clearAppBadge().catch(() => {});
  }, [vault, version]);
  const toggleNotifications = () =>
    run(async () => {
      if (notif === "granted") {
        await engine.current.unsubscribePush();
        setNotif("default");
        flash("已关闭消息通知");
      } else {
        await engine.current.subscribePush();
        setNotif("granted");
        flash("消息通知已开启");
      }
    });
  const openModal = (m) => {
    setError("");
    stopScan();
    setPreview(null);
    setModal(m);
  };
  const stopScan = () => {
    scanActive.current = false;
    setScanning(false);
    setScanStream(null);
    setScanError("");
  };
  const startScan = () => {
    scanActive.current = true;
    setScanning(true);
    setScanError("");
    setScanStream(null);
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setScanError("当前环境不支持摄像头扫码，请改用输入身份码。");
        return;
      }
      const attempts = [
        { video: { facingMode: { ideal: "environment" } }, audio: false },
        { video: true, audio: false },
      ];
      let lastError;
      for (const constraints of attempts) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (!scanActive.current) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          setScanStream(stream);
          return;
        } catch (e) {
          lastError = e;
          if (e?.name === "NotAllowedError" || e?.name === "SecurityError")
            break;
        }
      }
      if (scanActive.current)
        setScanError(cameraError(lastError || Error("无法获取摄像头")));
    })();
  };
  const lookupContact = (value) =>
    run(async () => {
      const id = normalizeId(value);
      if (!/^[0-9a-f]{64}$/.test(id)) throw Error("身份码格式不正确");
      const d = await engine.current.api("identity/" + id);
      stopScan();
      setPreview(d);
    });
  const confirmAdd = () =>
    run(async () => {
      const d = await engine.current.api("contacts", "POST", {
        id: preview.id,
      });
      await engine.current.refresh();
      setView("chats");
      choose(d.id);
      setModal(null);
      setPreview(null);
      flash("已添加好友");
    });
  const submitGroup = (event, groupId) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const members = String(data.get("members") || "").split(/[\n,，;；]+/).map(v => v.trim()).filter(Boolean);
    run(async () => {
      const id = await engine.current.createGroup(String(data.get("name") || ""), members, groupId);
      setView("chats");
      choose(id);
      setModal(null);
      flash(groupId ? "成员已加入群聊" : "群聊已创建，已同步给成员");
    });
  };
  const checkUpdate = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    setError("");
    try {
      if (!await checkForUpdate(vault)) flash("当前已是最新版本");
    } catch (e) { setError(e.message || "检查更新失败，请稍后重试"); }
    finally { setCheckingUpdate(false); }
  };
  const persist = async () => {
    await vault.save();
    render((n) => n + 1);
  };
  const send = () =>
    run(async () => {
      if (!draft.trim()) return;
      await engine.current.send(selected, draft.trim());
      setDraft("");
      setEmoji(false);
      nearBottom.current = true;
      bottom.current?.scrollIntoView({ behavior: "smooth" });
    });
  const fileChange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f)
      await run(async () => {
        await engine.current.send(selected, await prepareImage(f), "image");
        nearBottom.current = true;
      });
  };
  const active = conversations.filter((c) => c.active);
  const filtered =
    conversations
      .filter(
        (c) =>
          !c.blocked &&
          (c.active || state.messages.some((m) => m.peer === c.id)),
      )
      .filter((c) => label(c).toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => {
        const last = (id) =>
          state.messages.filter((m) => m.peer === id).at(-1)?.time || conversations.find(c => c.id === id)?.created || 0;
        return last(b.id) - last(a.id);
      }) || [];
  const handleAccountAuth = (e) => {
    e.preventDefault();
    const data = new FormData(e.target),
      name = String(data.get("username") || "").trim(),
      password = String(data.get("password") || ""),
      confirm = String(data.get("confirm") || ""),
      phrase = String(data.get("phrase") || "").trim().replace(/\s+/g, " ");
    if (authMode !== "recover" && !name) {
      setAuthError("请输入用户名");
      return;
    }
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    (async () => {
      try {
        if (authMode === "recover") {
          if (!phrase) throw Error("请输入找回密钥");
          if (password.length < 6) throw Error("新密码至少需要 6 位");
          if (password !== confirm) throw Error("两次输入的新密码不一致");
          const recovered = await requestRecovery(phrase, password);
          const signedIn = await signIn(recovered.username, password);
          const uid = signedIn.user?.id || "";
          if (!uid || !signedIn.session)
            throw Error("密码已重置，但自动登录未完成，请重试");
          userIdRef.current = uid;
          setUsername(recovered.username);
          setAccountName(recovered.username);
          setAuth("signedIn");
          await enterApp(uid);
          return;
        }
        if (password.length < 6) throw Error("密码至少需要 6 位");
        if (authMode === "register" && password !== confirm)
          throw Error("两次输入的密码不一致");
        if (authMode === "login") {
          const r = await signIn(name, password);
          userIdRef.current = r.user?.id || "";
        } else {
          const words = generateRecoveryPhrase();
          const r = await signUp(name, password, words.join(" "));
          if (!r.session) {
            setAuthError(
              "注册未完成：请在 Supabase 的 Authentication → Email 中关闭「Confirm email」，因为本应用不发送邮件。",
            );
            return;
          }
          userIdRef.current = r.user?.id || "";
          setRecoveryPhrase(words.join(" "));
          setAuth("signedIn");
          setAccountName(name);
          return;
        }
        setAuth("signedIn");
        setAccountName(name);
        await enterApp(userIdRef.current);
      } catch (e) {
        setAuthError(readableAuthError(e));
      } finally {
        setAuthBusy(false);
      }
    })();
  };
  const copyRecovery = () =>
    run(async () => {
      await navigator.clipboard.writeText(recoveryPhrase);
      flash("找回密钥已复制");
    });
  const confirmRecovery = () =>
    run(async () => {
      setRecoveryPhrase("");
      await enterApp(userIdRef.current);
    });
  const logout = () =>
    run(async () => {
      await signOut();
      engine.current?.stop();
      engine.current = null;
      release.current?.();
      release.current = null;
      userIdRef.current = "";
      setVault(null);
      setSelected(null);
      setView("chats");
      setReady("loading");
      setAuth("signedOut");
    });
  const submitAuth = (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    run(async () => {
      await start(
        await createVault(
          data.get("name").trim() || "我",
          vaultKeyFor(userIdRef.current),
        ),
      );
    });
  };
  if (auth === "signedOut")
    return (
      <div className="onboard">
        <div className="intro">
          <div className="wordmark">
            {logo}
            <b>INOU</b>
            <span>私域聊天</span>
          </div>
        </div>
        <main className="auth">
          <div className="auth-inner">
            <div className="auth-icon">
              <MessageCircle size={28} />
            </div>
            <h2>
              {authMode === "login"
                ? "登录 INOU"
                : authMode === "recover"
                  ? "找回账号"
                  : "注册账号"}
            </h2>
            <p className="muted">
              {authMode === "recover"
                ? "输入注册时保存的 8 个找回词，即可设置新密码，无需用户名。"
                : "用户名登录，聊天记录只保存在本机。"}
            </p>
            <form key={authMode} onSubmit={handleAccountAuth}>
              {authMode !== "recover" && <label>
                用户名
                <span className="username-row">
                  <input
                    name="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="username"
                    placeholder="输入用户名"
                  />
                  {authMode !== "recover" && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="随机用户名"
                      onClick={() => setUsername(genUsername())}
                    >
                      <RefreshCw size={15} />
                    </button>
                  )}
                </span>
              </label>}
              {authMode === "recover" && (
                <label>
                  找回密钥（8 个词，用空格隔开）
                  <input
                    name="phrase"
                    required
                    autoComplete="off"
                    placeholder="例如：词 词 词 词 词 词 词 词"
                  />
                </label>
              )}
              <label>
                {authMode === "recover" ? "新密码" : "密码"}
                <input
                  name="password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete={
                    authMode === "login" ? "current-password" : "new-password"
                  }
                  placeholder="至少 6 位"
                />
              </label>
              {authMode !== "login" && (
                <label>
                  {authMode === "recover" ? "确认新密码" : "确认密码"}
                  <input
                    name="confirm"
                    type="password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    placeholder="再输入一次"
                  />
                </label>
              )}
              {authNotice && <p role="status" className="auth-notice">{authNotice}</p>}
              {authError && (
                <div role="alert" className="error">
                  {authError}
                </div>
              )}
              <button className="primary full" disabled={authBusy}>
                {authBusy ? <LoaderCircle className="spin" size={18} /> : null}
                {authMode === "login"
                  ? "登录"
                  : authMode === "recover"
                    ? "重置密码"
                    : "注册"}
              </button>
            </form>
            <button
              className="text-btn full"
              onClick={() => {
                setAuthMode(authMode === "recover" ? "login" : authMode === "login" ? "register" : "login");
                setAuthError("");
                setAuthNotice("");
              }}
            >
              {authMode === "login"
                ? "没有账号？注册一个"
                : authMode === "recover"
                  ? "返回登录"
                  : "已有账号？去登录"}
            </button>
            {authMode === "login" && (
              <button
                className="text-btn full"
                onClick={() => {
                  setAuthMode("recover");
                  setAuthError("");
                  setAuthNotice("");
                }}
              >
                找回账号 / 重置密码
              </button>
            )}
          </div>
        </main>
      </div>
    );
  if (recoveryPhrase)
    return (
      <div className="onboard">
        <div className="intro">
          <div className="wordmark">
            {logo}
            <b>INOU</b>
            <span>私域聊天</span>
          </div>
        </div>
        <main className="auth">
          <div className="auth-inner">
            <div className="auth-icon">
              <KeyRound size={28} />
            </div>
            <h2>请保存你的找回密钥</h2>
            <p className="muted">
              下面 8 个词是找回密码的唯一凭证，只显示这一次。请抄写或复制到安全的地方，不要泄露给任何人。
            </p>
            <div className="recovery-grid">
              {recoveryPhrase.split(" ").map((w, i) => (
                <div className="recovery-word" key={i}>
                  <span>{i + 1}</span>
                  {w}
                </div>
              ))}
            </div>
            <button className="primary full" onClick={copyRecovery}>
              <Copy size={17} /> 复制密钥
            </button>
            <button className="secondary full" onClick={confirmRecovery}>
              我已保存，进入应用
            </button>
          </div>
        </main>
      </div>
    );
  if (!vault)
    return (
      <div className="onboard">
        <div className="intro">
          <div className="wordmark">
            {logo}
            <b>INOU</b>
            <span>私域聊天</span>
          </div>
          <div className="intro-main">
            <span className="eyebrow">JUST YOU & YOUR PEOPLE</span>
            <h1>
              亲近的人，
              <br />
              自在地聊。
            </h1>
            <p>
              用你的本地身份码，连接你信任的人。
              <br />
              聊天留在彼此的设备，陪伴回到聊天本身。
            </p>
            <div className="intro-art">
              <div className="art-bubble white">
                只属于你们的对话<span>•••</span>
              </div>
              <div className="art-bubble green">
                <ShieldCheck size={25} /> 记录，由自己保管。
              </div>
              <div className="art-foot">记录只保存在本机 · 无云端聊天记录</div>
            </div>
          </div>
          <small>简单连接，安心相处。</small>
        </div>
        <main className="auth">
          <div className="auth-inner">
            <div className="mobile-brand">
              {logo}
              <b>INOU</b>
            </div>
            <div className="auth-icon">
              <MessageCircle size={28} />
            </div>
            <h2>从一段对话开始</h2>
            <p className="muted">创建你的本地身份，邀请一位朋友加入。</p>
            {ready === "loading" && (
              <div className="working">
                <LoaderCircle className="spin" size={18} /> 正在打开…
              </div>
            )}
            {ready === "error" && (
              <>
                <div role="alert" className="error">
                  {error}
                </div>
                <button className="primary full" onClick={boot}>
                  重试
                </button>
                {bootNeedsReset && (
                  <button
                    className="text-btn full danger"
                    onClick={() =>
                      run(async () => {
                        await deleteVault(vaultKeyFor(userIdRef.current));
                        setError("");
                        setReady("create");
                      })
                    }
                  >
                    清除本机资料并重新开始
                  </button>
                )}
              </>
            )}
            {ready === "create" &&
              (isIOS && !standalone ? (
                <div className="install-guide">
                  <Smartphone />
                  <h3>先添加到主屏幕</h3>
                  <p>
                    在 Safari 点击分享按钮，选择“添加到主屏幕”，再从桌面打开
                    INOU 开始使用。
                  </p>
                  <small>
                    请在主屏幕应用中创建身份，以免记录保存在其他浏览器实例。
                  </small>
                </div>
              ) : (
                <form onSubmit={submitAuth}>
                  <label>
                    你的昵称
                    <input
                      name="name"
                      placeholder="朋友会看到的名字"
                      maxLength={24}
                      required
                      autoComplete="nickname"
                    />
                  </label>
                  {error && (
                    <div role="alert" className="error">
                      {error}
                    </div>
                  )}
                  <button className="primary full" disabled={busy}>
                    {busy ? <LoaderCircle className="spin" size={18} /> : null}
                    创建本地身份 <ArrowUpRight size={18} />
                  </button>
                </form>
              ))}
            <span className="dev-label">开发预览 {APP_VERSION} · 请勿用于敏感通信</span>
          </div>
        </main>
      </div>
    );
  return (
    <div className="app-shell">
      <div className={"app " + (selected ? "has-chat" : "")}>
        <aside className={"sidebar " + (view === "me" ? "profile-active" : "")}>
          <header className="side-header">
            <div className="wordmark">
              {logo}
              <b>INOU</b>
            </div>
            <button
              className="icon-btn"
              aria-label="添加好友"
              onClick={() => openModal("add")}
            >
              <Plus />
            </button>
          </header>
          <div className="connection">
            <i className={engine.current?.connected ? "online" : ""} />
            {engine.current?.connected
              ? "已连接 · 记录仅存本机"
              : "连接中 · 本地记录可用"}
          </div>
          {view !== "me" ? (
            <>
              <div className="search">
                <Search size={17} />
                <input
                  aria-label="搜索联系人"
                  placeholder="搜索联系人"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {view === "contacts" && (
                <button className="add-row" onClick={() => openModal("add")}>
                  <span>
                    <UserPlus size={22} />
                  </span>
                  <strong>添加新朋友</strong>
                  <ChevronRight size={18} />
                </button>
              )}
              <button className="add-row" onClick={() => openModal("createGroup")}>
                <span><Users size={22} /></span><strong>创建群聊</strong><ChevronRight size={18} />
              </button>
              <div className="list-heading">
                {view === "contacts" ? "我的联系人" : "最近聊天"}
                <span>
                  {view === "contacts" ? active.length : filtered.length}
                </span>
              </div>
              <div className="contact-list">
                {filtered.length ? (
                  filtered
                    .filter((c) => view !== "contacts" || c.active)
                    .map((c) => {
                      const last = state.messages
                          .filter((m) => m.peer === c.id)
                          .at(-1),
                        unread = state.messages.filter(
                          (m) =>
                            m.peer === c.id &&
                            m.sender !== state.identity.id &&
                            m.time > (c.lastRead || 0),
                        ).length;
                      return (
                        <button
                          className={
                            "contact-row " +
                            (selected === c.id ? "selected" : "")
                          }
                          key={c.id}
                          onClick={() => choose(c.id)}
                        >
                          <div className="avatar-wrap">
                            <Avatar name={label(c)} id={c.id} />
                            {unread > 0 && (
                              <i className="badge">
                                {unread > 99 ? "99+" : unread}
                              </i>
                            )}
                          </div>
                          <div className="contact-copy">
                            <div>
                              <strong>{c.isGroup && <Users size={14} />} {label(c)}</strong>
                              <time>{last ? time(last.time) : ""}</time>
                            </div>
                            <p>
                              {last?.status === "pending" ? "[待发送] " : ""}
                              {last
                                ? last.kind === "image"
                                  ? "[图片]"
                                  : last.body
                                : c.isGroup ? `${c.members.length} 位成员 · 已加入群聊` : "添加成功，打个招呼吧"}
                            </p>
                          </div>
                        </button>
                      );
                    })
                ) : (
                  <div className="list-empty">
                    <MessageCircle size={32} />
                    <h3>{search ? "没有找到联系人" : "还没有对话"}</h3>
                    <p>
                      {search ? "试试其他名字" : "添加第一位朋友，开始聊天。"}
                    </p>
                    {!search && (
                      <button
                        className="text-btn"
                        onClick={() => openModal("add")}
                      >
                        添加好友 <Plus size={15} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="local-note">
                <ShieldCheck size={15} /> 聊天记录只保存在这台设备
              </div>
            </>
          ) : (
            <div className="profile">
              <div className="profile-card">
                <Avatar
                  large
                  name={state.identity.name}
                  id={state.identity.id}
                />
                <h2>{state.identity.name}</h2>
                <span>本地身份 · {state.identity.id.slice(0, 8)}</span>
              </div>
              <button
                className="settings-row"
                onClick={() => openModal("identity")}
              >
                <KeyRound />
                <span>我的身份码</span>
                <ChevronRight />
              </button>
              <button
                className="settings-row"
                onClick={() => openModal("backup")}
              >
                <Download />
                <span>数据与备份</span>
                <ChevronRight />
              </button>
              <button
                className="settings-row"
                onClick={toggleNotifications}
                disabled={notif === "unsupported" || notif === "unavailable" || notif === "denied"}
              >
                <Bell />
                <span>
                  消息通知 ·{" "}
                  {notif === "granted"
                    ? "已开启"
                    : notif === "denied"
                      ? "已被系统拒绝"
                      : notif === "unsupported"
                        ? "环境不支持"
                        : notif === "unavailable"
                          ? "服务未配置"
                          : "未开启"}
                </span>
                <ChevronRight />
              </button>
              <button
                className="settings-row"
                onClick={() => openModal("blocked")}
              >
                <ShieldBan />
                <span>黑名单</span>
                <ChevronRight />
              </button>
              <button
                className="settings-row"
                onClick={() => openModal("install")}
              >
                <Smartphone />
                <span>安装到主屏幕</span>
                <ChevronRight />
              </button>
              {hasSupabase() && (
                <button className="settings-row danger" onClick={logout}>
                  <LogOut />
                  <span>退出登录</span>
                  <ChevronRight />
                </button>
              )}
              <div className="profile-info">
                <ShieldCheck size={19} />
                <h4>你的记录，你来保管</h4>
                <p>
                  对方不在线时，消息会加密暂存并提醒对方；内容始终端到端加密。
                </p>
                <small>版本 {APP_VERSION}</small>
              </div>
              <button className="settings-row update-check" disabled={checkingUpdate} onClick={checkUpdate}>
                <RefreshCw className={checkingUpdate ? "spinning" : ""} />
                <span>{checkingUpdate ? "正在检查并更新…" : "检查更新"}</span>
                <ChevronRight />
              </button>
            </div>
          )}
          <nav className="bottom-nav">
            {[
              ["chats", MessageCircle, "聊天"],
              ["contacts", ContactRound, "通讯录"],
              ["me", UserRound, "我"],
            ].map(([id, Icon, text]) => (
              <button
                key={id}
                className={view === id ? "active" : ""}
                onClick={() => {
                  setView(id);
                  setSelected(null);
                  setSearch("");
                }}
              >
                <Icon size={23} />
                <span>{text}</span>
              </button>
            ))}
          </nav>
        </aside>
        <main className={"conversation " + (!selected ? "welcome" : "")}>
          {contact ? (
            <>
              <header className="chat-header">
                <button
                  className="icon-btn mobile-back"
                  aria-label="返回"
                  onClick={() => setSelected(null)}
                >
                  <ChevronLeft />
                </button>
                <div>
                  <h2>{label(contact)}</h2>
                  <span>
                    <i
                      className={
                        engine.current?.peers.get(selected)?.channel
                          ?.readyState === "open"
                          ? "online"
                          : ""
                      }
                    />
                    {contact.isGroup ? `${contact.members.length} 位成员 · 群聊` : !contact.active
                      ? "关系已结束"
                      : engine.current?.peers.get(selected)?.channel
                            ?.readyState === "open"
                        ? "已连接，可以聊天"
                        : "等待双方上线"}
                  </span>
                </div>
                <button
                  className="icon-btn"
                  aria-label="聊天详情"
                  onClick={() => openModal("detail")}
                >
                  <MoreHorizontal />
                </button>
              </header>
              <div
                className="message-list"
                ref={scroll}
                onScroll={() => {
                  const el = scroll.current;
                  nearBottom.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                }}
              >
                <div className="conversation-notice">
                  <LockKeyhole size={13} />{" "}
                  {contact.isGroup ? "群消息加密投递，聊天记录保存在成员设备" : "消息通过加密连接传输，记录仅存双方设备"}
                </div>
                {messages.length === 0 && (
                  <div className="chat-start">
                    <Avatar large name={label(contact)} id={contact.id} />
                    <h3>{contact.isGroup ? `欢迎加入 ${label(contact)}` : `你和 ${label(contact)} 已成为好友`}</h3>
                    <p>从一句问候开始吧。</p>
                  </div>
                )}
                {messages.map((m, i) => {
                  const own =
                    m.sender === state.identity.id ||
                    m.sender === m.archiveOwner;
                  return (
                    <React.Fragment key={m.id}>
                      {(i === 0 || m.time - messages[i - 1].time > 300000) && (
                        <div className="message-time">
                          {new Date(m.time).toLocaleDateString("zh-CN", {
                            month: "long",
                            day: "numeric",
                          })}{" "}
                          {time(m.time)}
                        </div>
                      )}
                      <div className={"message " + (own ? "own" : "")}>
                        <Avatar
                          name={own ? state.identity.name : contact.isGroup ? contact.members.find(member => member.id === m.sender)?.name || "群成员" : label(contact)}
                          id={m.sender}
                        />
                        <div className="bubble-wrap">
                          {contact.isGroup && !own && <small className="sender-name">{contact.members.find(member => member.id === m.sender)?.name || "群成员"}</small>}
                          <div
                            className={
                              "bubble " +
                              (m.kind === "image" ? "image-bubble" : "")
                            }
                          >
                            {m.kind === "image" ? (
                              <button
                                onClick={() => setModal({ image: m.body })}
                                aria-label="查看图片"
                              >
                                <img src={m.body} alt="聊天图片" />
                              </button>
                            ) : (
                              m.body
                            )}
                          </div>
                          {own && (
                            <div className="message-status">
                              {m.status === "pending" ? (
                                <>
                                  <Clock3 size={11} />
                                  {m.groupId ? "等待联网投递" : "等待双方上线"}
                                </>
                              ) : m.status === "sent" ? (
                                <>
                                  <Check size={11} />
                                  已投递
                                </>
                              ) : m.status === "delivered" ? (
                                <>
                                  <Check size={11} />
                                  已送达
                                </>
                              ) : m.status === "cancelled" ? (
                                "已取消"
                              ) : m.status === "archived" ? (
                                "导入的历史记录"
                              ) : (
                                ""
                              )}
                              {m.status === "pending" && (
                                <button
                                  onClick={() =>
                                    run(async () => {
                                      m.status = "cancelled";
                                      await persist();
                                    })
                                  }
                                >
                                  取消
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
                <div ref={bottom} />
              </div>
              {newMessage && (
                <button
                  className="new-message"
                  onClick={() => {
                    nearBottom.current = true;
                    bottom.current?.scrollIntoView({ behavior: "smooth" });
                    setNewMessage(false);
                  }}
                >
                  回到最新消息 ↓
                </button>
              )}
              <div className="composer">
                <div className="composer-tools">
                  <button
                    className="icon-btn"
                    aria-label="表情"
                    disabled={!contact.active}
                    onClick={() => setEmoji(!emoji)}
                  >
                    <Smile size={22} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="发送图片"
                    disabled={!contact.active || busy}
                    onClick={() => fileInput.current.click()}
                  >
                    <ImagePlus size={22} />
                  </button>
                  <span>
                    {contact.active
                      ? "Enter 发送 · Shift + Enter 换行"
                      : "重新添加好友后才能继续聊天"}
                  </span>
                </div>
                {emoji && (
                  <div className="emoji-picker">
                    {[
                      "😊",
                      "👋",
                      "❤️",
                      "👍",
                      "🎉",
                      "☀️",
                      "🌿",
                      "☕",
                      "😂",
                      "🤗",
                      "✨",
                      "🌙",
                    ].map((e) => (
                      <button key={e} onClick={() => setDraft(draft + e)}>
                        {e}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  aria-label="消息"
                  placeholder={
                    contact.active ? "发一条消息…" : "当前会话不可发送"
                  }
                  disabled={!contact.active}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    state.drafts[selected] = e.target.value;
                    vault.save().catch(() => {});
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <span>
                    <LockKeyhole size={12} /> 记录只存本机
                  </span>
                  <button
                    className="send-btn"
                    onClick={send}
                    disabled={!draft.trim() || busy || !contact.active}
                  >
                    发送 <Send size={15} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="welcome-top">
                <span>属于你们的聊天空间</span>
                <span className="subtle-tag">
                  <LockKeyhole size={12} /> LOCAL FIRST
                </span>
              </div>
              <div className="welcome-content">
                <div className="welcome-symbol">
                  {logo}
                  <span className="orbit one" />
                  <span className="orbit two" />
                </div>
                <h1>每段对话，都有自己的空间。</h1>
                <p>
                  添加一位你信任的朋友。
                  <br />
                  简单地聊，记录留在彼此手里。
                </p>
                <div className="welcome-actions">
                  <button className="primary" onClick={() => openModal("add")}>
                    <UserPlus size={18} /> 添加好友
                  </button>
                  <button
                    className="secondary"
                    onClick={() => openModal("identity")}
                  >
                    <Link2 size={18} /> 分享我的身份码
                  </button>
                </div>
                <div className="welcome-features">
                  <span>
                    <KeyRound />
                    身份码连接
                  </span>
                  <span>
                    <ShieldCheck />
                    本地加密保存
                  </span>
                  <span>
                    <MessageCircle />
                    私聊与群聊
                  </span>
                </div>
              </div>
              <div className="welcome-footer">
                <span>INOU · 让对话回到彼此</span>
                <button onClick={() => openModal("install")}>
                  安装到手机 <ArrowUpRight size={14} />
                </button>
              </div>
            </>
          )}
        </main>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={fileChange}
      />
      <input
        ref={restoreInput}
        type="file"
        accept=".inou,application/json"
        hidden
        onChange={(e) => {
          setBackupFile(e.target.files[0]);
          e.target.value = "";
        }}
      />
      {error && !modal && (
        <div role="alert" className="floating-error">
          {error}
          <button aria-label="关闭错误" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {update && (
        <button
          className="update-banner"
          disabled={checkingUpdate}
          onClick={checkUpdate}
        >
          新版本已就绪，点击更新
        </button>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className={"modal " + (modal.image ? "image-modal" : "")}
            role="dialog"
            aria-modal="true"
            aria-label={modal.image ? "图片" : "设置"}
          >
            <button
              className="modal-close icon-btn"
              aria-label="关闭"
              onClick={() => {
                setModal(null);
                setError("");
              }}
            >
              <X />
            </button>
            {(modal === "createGroup" || modal === "inviteGroup") && (
              <form onSubmit={event => submitGroup(event, modal === "inviteGroup" ? contact?.id : undefined)}>
                <div className="modal-icon"><Users /></div>
                <h2>{modal === "createGroup" ? "创建群聊" : "邀请群成员"}</h2>
                <p>输入对方的身份码，对方的聊天列表会自动显示这个群，无需确认。</p>
                {modal === "createGroup" && <label>群名称<input name="name" required maxLength={32} placeholder="给群聊起个名字" /></label>}
                <label>成员身份码<textarea name="members" required rows={4} placeholder="每行一个身份码，至少添加一位其他用户" /></label>
                <small className="muted">最多 20 人；也可以用逗号分隔多个身份码。</small>
                <button className="primary full" disabled={busy} type="submit">{busy ? "正在处理…" : modal === "createGroup" ? "创建并邀请" : "确认邀请"}</button>
              </form>
            )}
            {modal === "detail" && contact?.isGroup && (
              <>
                <div className="modal-icon"><Users /></div>
                <h2>{label(contact)}</h2>
                <p>{contact.members.length} 位成员</p>
                <div className="group-members">{contact.members.map(member => (
                  <div className="group-member" key={member.id}>
                    <Avatar name={member.name || "群成员"} id={member.id} />
                    <span>{member.name || "群成员"}{member.id === state.identity.id ? "（我）" : ""}</span>
                    {member.id === contact.owner && <small>群主</small>}
                  </div>
                ))}</div>
                <button className="primary full" disabled={!contact.active} onClick={() => openModal("inviteGroup")}><UserPlus size={18} /> 通过身份码邀请</button>
                <button className="settings-row" onClick={() => openModal("clear")}><Trash2 /><span>清空本机聊天记录</span><ChevronRight /></button>
              </>
            )}
            {modal === "add" && (
              <>
                <div className="modal-icon">
                  {preview ? (
                    <ContactRound />
                  ) : scanning ? (
                    <QrCode />
                  ) : (
                    <UserPlus />
                  )}
                </div>
                {preview ? (
                  <>
                    <h2>确认添加</h2>
                    <p>确认下面的名字和身份码无误后，再添加对方。</p>
                    <div className="preview-card">
                      <Avatar large name={preview.name || "新朋友"} id={preview.id} />
                      <div className="preview-name">{preview.name || "未命名"}</div>
                      <div className="preview-code">{formatId(preview.id)}</div>
                    </div>
                    <button
                      className="primary full"
                      disabled={busy}
                      onClick={confirmAdd}
                    >
                      确定添加 <ArrowUpRight size={17} />
                    </button>
                    <button
                      className="text-btn full"
                      onClick={() => setPreview(null)}
                    >
                      返回
                    </button>
                    <div className="modal-tip">
                      <ShieldCheck size={16} /> 确认是本人后再添加；名字由对方自行设置。
                    </div>
                  </>
                ) : scanning ? (
                  <>
                    <h2>扫描二维码</h2>
                    {scanError ? (
                      <>
                        <div className="scan-error">
                          <CameraOff size={17} /> {scanError}
                        </div>
                        <button className="text-btn full" onClick={stopScan}>
                          返回手动输入
                        </button>
                      </>
                    ) : scanStream ? (
                      <Scanner
                        stream={scanStream}
                        onResult={lookupContact}
                        onCancel={stopScan}
                      />
                    ) : (
                      <div className="scanner-status">
                        <LoaderCircle size={20} className="spin" /> 正在打开摄像头…
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <h2>添加一位新朋友</h2>
                    <p>扫描对方二维码，或输入身份码，先查看对方信息。</p>
                    <button
                      className="primary full"
                      onClick={startScan}
                    >
                      <ScanLine size={17} /> 扫描二维码
                    </button>
                    <div className="or-divider">或</div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        lookupContact(new FormData(e.target).get("id"));
                      }}
                    >
                      <label>
                        对方身份码
                        <input
                          name="id"
                          className="code-input"
                          placeholder="INOU-XXXX-XXXX-XXXX-…"
                          required
                          autoCapitalize="characters"
                          autoComplete="off"
                        />
                      </label>
                      <button className="primary full" disabled={busy}>
                        查找对方 <ArrowUpRight size={17} />
                      </button>
                    </form>
                  </>
                )}
              </>
            )}
            {modal === "identity" && (
              <>
                <div className="modal-icon">
                  <QrCode />
                </div>
                <h2>我的身份码</h2>
                <p>让对方扫描二维码，或复制身份码发送给对方。</p>
                <IdentityQR value={formatId(state.identity.id)} />
                <div className="id-code">{formatId(state.identity.id)}</div>
                <small className="center muted">
                  长期有效 · 与你的本地身份一一对应
                </small>
                <button
                  className="primary full"
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(
                        formatId(state.identity.id),
                      );
                      flash("身份码已复制");
                    })
                  }
                >
                  <Copy size={17} /> 复制身份码
                </button>
                <div className="modal-tip">
                  <ShieldCheck size={16} /> 持有你身份码的人可以直接添加你。请只分享给信任的人。
                </div>
              </>
            )}
            {modal === "backup" && (
              <>
                <div className="modal-icon">
                  <Download />
                </div>
                <h2>数据与备份</h2>
                <p>
                  {state.messages.length} 条本地消息 · {active.length} 位联系人
                </p>
                <div className="backup-note">
                  备份只包含历史记录，不包含登录身份。换机导入后需要重新加好友。保存到
                  iCloud 文件夹可能由系统同步到云端。
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.target);
                    run(async () => {
                      if (f.get("password") !== f.get("confirm"))
                        throw Error("两次备份口令不一致");
                      const archive = await exportArchive(
                          state,
                          f.get("password"),
                        ),
                        url = URL.createObjectURL(
                          new Blob([JSON.stringify(archive)], {
                            type: "application/json",
                          }),
                        ),
                        a = document.createElement("a");
                      a.href = url;
                      a.download = `INOU-${new Date().toISOString().slice(0, 10)}.inou`;
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 30000);
                      state.lastBackup = Date.now();
                      await persist();
                      flash("已生成加密备份，请妥善保存");
                    });
                  }}
                >
                  <label>
                    备份口令
                    <input
                      name="password"
                      type="password"
                      minLength={8}
                      required
                      placeholder="至少 8 位，请单独保存"
                    />
                  </label>
                  <label>
                    确认备份口令
                    <input
                      name="confirm"
                      type="password"
                      required
                      placeholder="再次输入备份口令"
                    />
                  </label>
                  <button className="primary full" disabled={busy}>
                    <Download size={17} /> 导出加密备份
                  </button>
                </form>
                <hr />
                <button
                  className="secondary full"
                  onClick={() => restoreInput.current.click()}
                >
                  <Upload size={17} /> 选择备份文件
                </button>
                {backupFile && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const pass = new FormData(e.target).get("password");
                      run(async () => {
                        if (backupFile.size > 100 * 1024 * 1024)
                          throw Error("当前版本仅支持 100 MB 以内备份");
                        const data = await readArchive(
                            JSON.parse(await backupFile.text()),
                            pass,
                          ),
                          old = structuredClone(state);
                        let count = 0;
                        for (const c of data.contacts) {
                          if (
                            typeof c.id === "string" &&
                            !state.contacts.some((x) => x.id === c.id)
                          )
                            state.contacts.push({
                              id: c.id,
                              name: String(c.name || "历史联系人").slice(0, 32),
                              remark: String(c.remark || "").slice(0, 32),
                              active: false,
                            });
                        }
                        state.groups ||= [];
                        for (const g of data.groups || []) {
                          if (!state.groups.some(existing => existing.id === g.id)) state.groups.push({
                            id: g.id, name: g.name, owner: g.owner, members: g.members.map(m => ({ id: m.id, name: String(m.name || "群成员").slice(0, 32) })), isGroup: true, active: false,
                          });
                        }
                        for (const m of data.messages) {
                          if (
                            !state.messages.some(
                              (x) => x.id === m.id && x.sender === m.sender,
                            )
                          ) {
                            state.messages.push({
                              ...m,
                              status: "archived",
                              archiveOwner: m.archiveOwner || data.owner,
                            });
                            count++;
                          }
                        }
                        try {
                          await persist();
                        } catch (e) {
                          Object.assign(state, old);
                          throw e;
                        }
                        setBackupFile(null);
                        flash(`已导入 ${count} 条历史记录`);
                      });
                    }}
                  >
                    <p className="file-name">{backupFile.name}</p>
                    <label>
                      该备份的口令
                      <input type="password" name="password" required />
                    </label>
                    <button className="secondary full" disabled={busy}>
                      导入历史记录
                    </button>
                  </form>
                )}
                <small className="muted">
                  {state.lastBackup
                    ? "上次导出：" +
                      new Date(state.lastBackup).toLocaleString("zh-CN")
                    : "还没有导出过备份"}
                </small>
              </>
            )}
            {modal === "detail" && contact && !contact.isGroup && (
              <>
                <Avatar large name={label(contact)} id={contact.id} />
                <h2>{label(contact)}</h2>
                <label>
                  本地备注
                  <input
                    value={contact.remark || ""}
                    placeholder="设置备注名"
                    maxLength={24}
                    onChange={(e) => {
                      contact.remark = e.target.value;
                      persist().catch(() => {});
                    }}
                  />
                </label>
                <div className="safety-code">
                  <ShieldCheck size={18} />
                  <strong>双方安全码</strong>
                  <p>通过其他可信渠道核对相同代码，确认联系的是彼此。</p>
                  <code>
                    {[state.identity.id, contact.id]
                      .sort()
                      .map((id) => id.slice(0, 16))
                      .join(" · ")}
                  </code>
                </div>
                <button
                  className="settings-row"
                  onClick={() => openModal("clear")}
                >
                  <Trash2 />
                  <span>清空本机聊天记录</span>
                  <ChevronRight />
                </button>
                {contact.active && (
                  <>
                    <button
                      className="settings-row danger"
                      onClick={() => openModal("remove")}
                    >
                      <LogOut />
                      <span>删除好友</span>
                      <ChevronRight />
                    </button>
                    <button
                      className="settings-row danger"
                      onClick={() => openModal("block")}
                    >
                      <ShieldBan />
                      <span>加入黑名单</span>
                      <ChevronRight />
                    </button>
                  </>
                )}
              </>
            )}
            {["clear", "remove", "block"].includes(modal) && (
              <>
                <div className="modal-icon">
                  <Trash2 />
                </div>
                <h2>
                  {modal === "clear"
                    ? "清空这段聊天？"
                    : modal === "block"
                      ? "将这位朋友加入黑名单？"
                      : "删除这位好友？"}
                </h2>
                <p>
                  {modal === "clear"
                    ? "本机记录将被删除，待发消息一并取消。对方的记录不受影响，备份中的副本仍保留。"
                    : "将停止发送待发消息，本机历史记录仍保留。再次联系需要对方的身份码。"}
                </p>
                <button
                  className="danger-btn full"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (modal === "clear") {
                        const old = state.messages;
                        state.messages = state.messages.filter(
                          (m) => m.peer !== selected,
                        );
                        try {
                          await persist();
                        } catch (e) {
                          state.messages = old;
                          throw e;
                        }
                      } else
                        await engine.current.remove(
                          selected,
                          modal === "block",
                        );
                      setModal(null);
                      flash(
                        state.relationOps?.some((op) => op.peer === selected)
                          ? "已在本机生效，联网后同步"
                          : "操作已完成",
                      );
                    })
                  }
                >
                  确认
                  {modal === "clear"
                    ? "清空"
                    : modal === "block"
                      ? "拉黑"
                      : "删除"}
                </button>
                <button
                  className="secondary full"
                  onClick={() => setModal("detail")}
                >
                  取消
                </button>
              </>
            )}
            {modal === "blocked" && (
              <>
                <h2>黑名单</h2>
                <p>解除拉黑后，需要用对方的身份码重新建立关系。</p>
                {state.contacts
                  .filter((c) => c.blocked)
                  .map((c) => (
                    <div className="blocked-row" key={c.id}>
                      <Avatar name={label(c)} id={c.id} />
                      <span>{label(c)}</span>
                      <button
                        className="text-btn"
                        disabled={
                          busy ||
                          state.relationOps?.some((op) => op.peer === c.id)
                        }
                        onClick={() =>
                          run(async () => {
                            await engine.current.api(
                              "blocks/" + c.id,
                              "DELETE",
                            );
                            c.blocked = false;
                            await persist();
                          })
                        }
                      >
                        解除拉黑
                      </button>
                    </div>
                  ))}
                {!state.contacts.some((c) => c.blocked) && (
                  <div className="blank-small">黑名单为空</div>
                )}
              </>
            )}
            {modal === "install" && (
              <>
                <div className="modal-icon">
                  <Smartphone />
                </div>
                <h2>
                  {standalone ? "已在独立窗口中运行" : "把 INOU 放到主屏幕"}
                </h2>
                <p>
                  iPhone：用 Safari 打开正式 HTTPS 地址，点击分享 →
                  添加到主屏幕。
                </p>
                <ol className="install-steps">
                  <li>从桌面图标打开 INOU</li>
                  <li>在该实例中创建本地身份</li>
                  <li>分享我的身份码，邀请朋友加入</li>
                </ol>
                <div className="backup-note">
                  当前为本地开发版。手机安装需要 HTTPS 部署；普通局域网 HTTP
                  不支持安全通信能力。切换使用入口前，请先备份记录。
                </div>
              </>
            )}
            {modal.image && <img src={modal.image} alt="图片预览" />}
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
            {busy && (
              <div className="working">
                <LoaderCircle className="spin" size={15} /> 正在处理…
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
