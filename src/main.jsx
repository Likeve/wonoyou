import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
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
import { registerSW } from "virtual:pwa-register";
import {
  hasVault,
  createVault,
  unlockVault,
  exportArchive,
  readArchive,
  prepareImage,
  digest,
} from "./vault";
import { ChatEngine } from "./engine";
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
    return "没有摄像头权限，请在系统设置中允许访问。";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "没有找到可用的摄像头。";
  if (name === "NotReadableError")
    return "摄像头正被其他应用占用，请稍后再试。";
  return "无法启动摄像头，请改用输入邀请码。";
};

function InviteQR({ value }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let ok = true;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
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
    <img className="qr-code" src={url} alt="邀请码二维码" />
  ) : (
    <div className="qr-placeholder">
      <LoaderCircle size={18} className="spin" /> 正在生成二维码…
    </div>
  );
}

function Scanner({ onResult, onCancel }) {
  const videoRef = useRef(null),
    canvasRef = useRef(null),
    streamRef = useRef(null),
    rafRef = useRef(0),
    doneRef = useRef(false),
    onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);
  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("当前环境不支持摄像头扫码，请改用输入邀请码。");
          setStarting(false);
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await video.play();
        setStarting(false);
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const tick = () => {
          if (stopped || doneRef.current) return;
          if (video.readyState >= video.HAVE_ENOUGH_DATA) {
            const w = video.videoWidth,
              h = video.videoHeight;
            if (w && h) {
              canvas.width = w;
              canvas.height = h;
              ctx.drawImage(video, 0, 0, w, h);
              const img = ctx.getImageData(0, 0, w, h);
              const code = jsQR(img.data, w, h, {
                inversionAttempts: "dontInvert",
              });
              if (code?.data) {
                doneRef.current = true;
                streamRef.current?.getTracks().forEach((t) => t.stop());
                onResultRef.current(code.data);
                return;
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (!stopped) {
          setError(cameraError(e));
          setStarting(false);
        }
      }
    })();
    return () => {
      stopped = true;
      doneRef.current = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);
  return (
    <div className="scanner">
      <div className="scanner-view">
        <video ref={videoRef} muted playsInline />
        {starting && (
          <div className="scanner-status">
            <LoaderCircle size={20} className="spin" /> 正在打开摄像头…
          </div>
        )}
        {!starting && !error && <i className="scanner-frame" />}
      </div>
      {error ? (
        <div className="scan-error">
          <CameraOff size={17} /> {error}
        </div>
      ) : (
        <p className="muted center scan-hint">
          将对方二维码放入框内，识别后自动添加。
        </p>
      )}
      <button
        className="text-btn full"
        onClick={() => {
          onCancel();
        }}
      >
        返回手动输入
      </button>
    </div>
  );
}

function App() {
  const [exists, setExists] = useState(null),
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
    [invite, setInvite] = useState(null),
    [scanning, setScanning] = useState(false),
    [backupFile, setBackupFile] = useState(null),
    [update, setUpdate] = useState(null),
    [emoji, setEmoji] = useState(false);
  const engine = useRef(null),
    bottom = useRef(null),
    scroll = useRef(null),
    fileInput = useRef(null),
    restoreInput = useRef(null),
    release = useRef(null),
    nearBottom = useRef(true),
    [newMessage, setNewMessage] = useState(false);
  const state = vault?.state,
    contact = state?.contacts.find((c) => c.id === selected),
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
  useEffect(() => {
    hasVault()
      .then(setExists)
      .catch(() => setError("无法使用本地存储，请退出无痕模式后重试"));
    const updater = registerSW({
      onNeedRefresh() {
        setUpdate(() => updater);
      },
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
    setExists(true);
    const e = new ChatEngine(
      v,
      () => render((n) => n + 1),
      (text) => setError(text),
    );
    engine.current = e;
    e.start().catch((e) => setError(e.message));
    navigator.storage?.persist?.().catch(() => {});
  };
  const lock = async () => {
    const v = vault;
    engine.current?.stop();
    await v?.flush().catch(() => {});
    engine.current = null;
    setVault(null);
    setSelected(null);
    setModal(null);
    setDraft("");
    setInvite(null);
    setSearch("");
    release.current?.();
    release.current = null;
  };
  useEffect(() => {
    if (!vault) return;
    let timer,
      hiddenAt = 0;
    const visibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        timer = setTimeout(() => lock(), 60000);
      } else {
        clearTimeout(timer);
        if (hiddenAt && Date.now() - hiddenAt >= 60000) lock();
        else engine.current?.tick();
        hiddenAt = 0;
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [vault]);
  useEffect(() => {
    if (vault && selected && !document.hidden && nearBottom.current) {
      const c = vault.state.contacts.find((c) => c.id === selected);
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
    const c = state.contacts.find((c) => c.id === id);
    if (c) {
      c.lastRead = Date.now();
      vault.save().catch(() => {});
    }
    render((n) => n + 1);
  };
  const openModal = (m) => {
    setError("");
    setScanning(false);
    setModal(m);
  };
  const addContact = (code) =>
    run(async () => {
      const d = await engine.current.api("contacts", "POST", { code });
      await engine.current.refresh();
      setView("chats");
      choose(d.id);
      setModal(null);
      flash("已添加好友");
    });
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
  const active = state?.contacts.filter((c) => c.active) || [];
  const filtered =
    state?.contacts
      .filter(
        (c) =>
          !c.blocked &&
          (c.active || state.messages.some((m) => m.peer === c.id)),
      )
      .filter((c) => label(c).toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => {
        const last = (id) =>
          state.messages.filter((m) => m.peer === id).at(-1)?.time || 0;
        return last(b.id) - last(a.id);
      }) || [];
  const submitAuth = (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    run(async () => {
      const pass = data.get("password");
      if (!exists && pass.length < 8) throw Error("请设置至少 8 位的解锁口令");
      if (!exists && pass !== data.get("confirm"))
        throw Error("两次口令不一致");
      await start(
        exists
          ? await unlockVault(pass)
          : await createVault(data.get("name").trim() || "我", pass),
      );
    });
  };
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
              用一个邀请码，连接你信任的人。
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
              <div className="art-foot">
                <LockKeyhole size={15} /> 本机加密保存 · 无云端聊天记录
              </div>
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
              {exists ? <LockKeyhole size={28} /> : <MessageCircle size={28} />}
            </div>
            <h2>{exists ? "欢迎回来" : "从一段对话开始"}</h2>
            <p className="muted">
              {exists
                ? "输入口令，解锁这台设备上的聊天记录。"
                : "创建你的本地身份，邀请一位朋友加入。"}
            </p>
            {isIOS && !standalone ? (
              <div className="install-guide">
                <Smartphone />
                <h3>先添加到主屏幕</h3>
                <p>
                  在 Safari 点击分享按钮，选择“添加到主屏幕”，再从桌面打开 INOU
                  开始使用。
                </p>
                <small>
                  请在主屏幕应用中创建身份，以免记录保存在其他浏览器实例。
                </small>
              </div>
            ) : (
              <form onSubmit={submitAuth}>
                {!exists && (
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
                )}
                <label>
                  {exists ? "解锁口令" : "设置解锁口令"}
                  <input
                    name="password"
                    type="password"
                    placeholder={
                      exists ? "输入本机解锁口令" : "至少 8 位，建议使用长口令"
                    }
                    required
                    minLength={exists ? 1 : 8}
                    autoComplete={exists ? "current-password" : "new-password"}
                  />
                </label>
                {!exists && (
                  <label>
                    确认口令
                    <input
                      name="confirm"
                      type="password"
                      placeholder="再次输入解锁口令"
                      required
                      autoComplete="new-password"
                    />
                  </label>
                )}
                {error && (
                  <div role="alert" className="error">
                    {error}
                  </div>
                )}
                <button
                  className="primary full"
                  disabled={busy || exists === null}
                >
                  {busy ? <LoaderCircle className="spin" size={18} /> : null}
                  {exists ? "解锁聊天" : "创建本地身份"}
                  <ArrowUpRight size={18} />
                </button>
              </form>
            )}
            <div className="auth-note">
              <ShieldCheck size={19} />
              <span>
                口令不会上传。忘记口令或清理网站数据后，未备份的聊天记录将无法恢复。
              </span>
            </div>
            <span className="dev-label">开发预览 0.1 · 请勿用于敏感通信</span>
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
                              <strong>{label(c)}</strong>
                              <time>{last ? time(last.time) : ""}</time>
                            </div>
                            <p>
                              {last?.status === "pending" ? "[待发送] " : ""}
                              {last
                                ? last.kind === "image"
                                  ? "[图片]"
                                  : last.body
                                : "添加成功，打个招呼吧"}
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
                onClick={() => openModal("invite")}
              >
                <KeyRound />
                <span>我的邀请码</span>
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
              <button className="settings-row" onClick={() => run(lock)}>
                <LockKeyhole />
                <span>锁定应用</span>
                <ChevronRight />
              </button>
              <div className="profile-info">
                <ShieldCheck size={19} />
                <h4>你的记录，你来保管</h4>
                <p>没有云端消息箱。双方打开应用后，待发消息才能送达。</p>
                <small>开发预览 0.1</small>
              </div>
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
                    {!contact.active
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
                  消息通过加密连接传输，记录仅存双方设备
                </div>
                {messages.length === 0 && (
                  <div className="chat-start">
                    <Avatar large name={label(contact)} id={contact.id} />
                    <h3>你和 {label(contact)} 已成为好友</h3>
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
                          name={own ? state.identity.name : label(contact)}
                          id={m.sender}
                        />
                        <div className="bubble-wrap">
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
                                  等待双方上线
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
                    <LockKeyhole size={12} /> 本机加密保存
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
                    onClick={() => openModal("invite")}
                  >
                    <Link2 size={18} /> 分享我的邀请码
                  </button>
                </div>
                <div className="welcome-features">
                  <span>
                    <KeyRound />
                    邀请码连接
                  </span>
                  <span>
                    <ShieldCheck />
                    本地加密保存
                  </span>
                  <span>
                    <MessageCircle />
                    一对一私聊
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
          onClick={() =>
            run(async () => {
              await vault.flush();
              update(true);
            })
          }
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
            {modal === "add" && (
              <>
                <div className="modal-icon">
                  {scanning ? <QrCode /> : <UserPlus />}
                </div>
                <h2>添加一位新朋友</h2>
                {scanning ? (
                  <Scanner
                    onResult={addContact}
                    onCancel={() => setScanning(false)}
                  />
                ) : (
                  <>
                    <p>扫描对方二维码，或输入邀请码，即可成为好友。</p>
                    <button
                      className="primary full"
                      onClick={() => setScanning(true)}
                    >
                      <ScanLine size={17} /> 扫描二维码
                    </button>
                    <div className="or-divider">或</div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        addContact(new FormData(e.target).get("code"));
                      }}
                    >
                      <label>
                        好友邀请码
                        <input
                          name="code"
                          className="code-input"
                          placeholder="INOU-XXXXX-XXXXX-…"
                          required
                          autoCapitalize="characters"
                          autoComplete="off"
                        />
                      </label>
                      <button className="primary full" disabled={busy}>
                        添加好友 <ArrowUpRight size={17} />
                      </button>
                    </form>
                  </>
                )}
                <div className="modal-tip">
                  <ShieldCheck size={16} /> 只与持有邀请码的人建立联系。
                </div>
              </>
            )}
            {modal === "invite" && (
              <>
                <div className="modal-icon">
                  <KeyRound />
                </div>
                <h2>我的邀请码</h2>
                <p>让对方扫描二维码，或复制邀请码发送给对方。</p>
                {invite ? (
                  <>
                    <InviteQR value={invite.code} />
                    <div className="invite-code">{invite.code}</div>
                    <small className="center muted">
                      单次使用 ·{" "}
                      {new Date(invite.expires).toLocaleString("zh-CN")} 前有效
                    </small>
                    <button
                      className="primary full"
                      onClick={() =>
                        run(async () => {
                          await navigator.clipboard.writeText(invite.code);
                          flash("邀请码已复制");
                        })
                      }
                    >
                      <Copy size={17} /> 复制邀请码
                    </button>
                    <button
                      className="text-btn full"
                      onClick={() =>
                        run(async () => {
                          await engine.current.api("invites", "DELETE");
                          setInvite(null);
                          flash("未使用的邀请码已失效");
                        })
                      }
                    >
                      撤销未使用的邀请码
                    </button>
                  </>
                ) : (
                  <button
                    className="primary full"
                    disabled={busy}
                    onClick={() =>
                      run(async () =>
                        setInvite(await engine.current.api("invites", "POST")),
                      )
                    }
                  >
                    <Plus size={18} /> 生成邀请码
                  </button>
                )}
                <div className="modal-tip">
                  持有此码的人可以直接添加你，无需再次确认。请勿公开发布。
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
            {modal === "detail" && contact && (
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
                    : "将停止发送待发消息，本机历史记录仍保留。再次联系需要新的邀请码。"}
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
                <p>解除拉黑后，需要用新邀请码重新建立关系。</p>
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
                  <li>保存邀请码，邀请朋友加入</li>
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
