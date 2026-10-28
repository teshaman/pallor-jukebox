/**
 * Pallor Jukebox — Foundry side.
 *
 * A thin API over theripper93's "Youtube Player Widget" (fvtt-youtube-player).
 * The widget already plays whatever the world setting `currentVideo` holds and
 * keeps playlists in the world setting `playlists`; this module only drives those
 * settings so an assistant (through Claude Bridge) or a macro can search YouTube,
 * play a video for everyone, keep a "Jukebox" playlist, pause, resume, stop and
 * report what is playing.
 *
 * Usage (GM client):
 *   const jb = game.modules.get("pallor-jukebox").api;
 *   await jb.search("medieval tavern ambience", { max: 5, minMinutes: 30 });
 *   await jb.play("vyg5jJrZ42s");            // id or any YouTube URL
 *   await jb.queue("https://youtu.be/RUn1dJY6syc");
 *   await jb.pause(); await jb.resume(); await jb.next(); await jb.stop();
 *   jb.now(); jb.list();
 */

const MOD = "pallor-jukebox";
const WIDGET = "fvtt-youtube-player";
const LOG = "Pallor Jukebox |";

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MOD, "playlistName", {
    name: "Jukebox playlist name",
    hint: "Tracks played or queued through the API are kept in this playlist of the YouTube Player Widget.",
    scope: "world",
    config: true,
    type: String,
    default: "Jukebox"
  });
  game.settings.register(MOD, "defaultMinMinutes", {
    name: "Default minimum length (minutes) for searches",
    hint: "search() drops shorter videos unless the call passes its own minMinutes. 0 = keep everything.",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });
});

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const getS = (key) => game.settings.get(WIDGET, key);
const setS = (key, value) => game.settings.set(WIDGET, key, value);
const playlistName = () => game.settings.get(MOD, "playlistName") || "Jukebox";

function requireWidget() {
  if (!game.modules.get(WIDGET)?.active) throw new Error(`${LOG} the module "${WIDGET}" (Youtube Player Widget) is not active`);
  if (!game.user.isGM) throw new Error(`${LOG} GM only (the widget's settings are world settings)`);
}

/** Accepts a bare 11-character id or any YouTube URL (watch, youtu.be, embed, shorts, live). */
function parseVideoId(input) {
  const s = String(input ?? "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.replace(/^www\./, "") === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[1];
  } catch (_) { /* not a URL */ }
  return null;
}

const toUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

function decodeEntities(s) {
  const t = document.createElement("textarea");
  t.innerHTML = String(s ?? "");
  return t.value;
}

function isoToSeconds(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return null;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

function formatSeconds(s) {
  if (s == null) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

async function youtubeApi(endpoint, params) {
  const key = getS("googleApiKey");
  if (!key) throw new Error(`${LOG} no Google API key set in the Youtube Player Widget settings`);
  const q = new URLSearchParams({ ...params, key });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${q}`);
  const j = await r.json();
  if (j.error) throw new Error(`${LOG} YouTube API: ${j.error.message}`);
  return j;
}

/** Title, channel and length for up to 50 ids. */
async function details(ids) {
  if (!ids.length) return [];
  const j = await youtubeApi("videos", { part: "snippet,contentDetails,status", id: ids.join(",") });
  return j.items.map((v) => {
    const seconds = isoToSeconds(v.contentDetails?.duration);
    return {
      id: v.id,
      url: toUrl(v.id),
      title: decodeEntities(v.snippet?.title),
      channel: v.snippet?.channelTitle ?? "",
      seconds,
      duration: formatSeconds(seconds),
      embeddable: v.status?.embeddable !== false
    };
  });
}

function getPlaylists() {
  return foundry.utils.deepClone(getS("playlists") ?? []);
}

function ensureJukebox(playlists) {
  const name = playlistName();
  let p = playlists.find((x) => x.name === name);
  if (!p) {
    p = { id: foundry.utils.randomID(), name, active: false, autoplay: true, tracks: [] };
    playlists.push(p);
  }
  if (p.autoplay === undefined) p.autoplay = true;
  return p;
}

async function resolveTrack(input, title) {
  const id = parseVideoId(input);
  if (!id) throw new Error(`${LOG} not a YouTube video id or URL: ${input}`);
  let t = title;
  if (!t) {
    const [d] = await details([id]).catch(() => []);
    t = d?.title ?? id;
  }
  return { id, url: toUrl(id), title: t };
}

/** The widget only reloads when the setting actually changes, so re-playing the same video needs a reset first. */
async function setCurrent(url) {
  if (getS("currentVideo") === url) await setS("currentVideo", "");
  await setS("currentVideo", url);
}

/* -------------------------------------------- */
/*  API                                         */
/* -------------------------------------------- */

/**
 * Search YouTube. Returns up to `max` (1-25) embeddable videos with title, channel and length,
 * dropping anything shorter than `minMinutes` (default: the module setting).
 */
async function search(query, { max = 5, minMinutes } = {}) {
  requireWidget();
  if (!query) throw new Error(`${LOG} search needs a query`);
  const min = minMinutes ?? game.settings.get(MOD, "defaultMinMinutes") ?? 0;
  const j = await youtubeApi("search", {
    part: "snippet",
    type: "video",
    videoEmbeddable: "true",
    maxResults: String(Math.min(Math.max(Number(max) || 5, 1), 25)),
    q: query
  });
  const ids = j.items.map((i) => i.id?.videoId).filter(Boolean);
  const found = await details(ids);
  return found.filter((v) => v.embeddable && (!min || (v.seconds ?? 0) >= min * 60));
}

/**
 * Play a video for everyone now. By default it is also added to the Jukebox playlist and
 * marked as the active track, so the widget's autoplay continues from it.
 */
async function play(input, { title, save = true, loop = false } = {}) {
  requireWidget();
  const tr = await resolveTrack(input, title);
  if (save) {
    const playlists = getPlaylists();
    const jb = ensureJukebox(playlists);
    for (const p of playlists) {
      p.active = p === jb;
      for (const t of p.tracks) t.active = false;
    }
    let track = jb.tracks.find((t) => parseVideoId(t.url) === tr.id);
    if (!track) {
      track = { url: tr.url, title: tr.title, active: false, repeat: false };
      jb.tracks.push(track);
    }
    track.active = true;
    track.repeat = !!loop;
    await setS("playlists", playlists);
  }
  await setCurrent(tr.url);
  console.log(LOG, "playing", tr.title, tr.url);
  return now();
}

/** Add a video to the end of the Jukebox playlist without interrupting what is playing. */
async function queue(input, { title } = {}) {
  requireWidget();
  const tr = await resolveTrack(input, title);
  const playlists = getPlaylists();
  const jb = ensureJukebox(playlists);
  if (!playlists.some((p) => p.active)) jb.active = true;
  if (!jb.tracks.some((t) => parseVideoId(t.url) === tr.id)) {
    jb.tracks.push({ url: tr.url, title: tr.title, active: false, repeat: false });
  }
  await setS("playlists", playlists);
  return list();
}

/** Jump to the next track of the active playlist (wraps around). */
async function next() {
  requireWidget();
  const playlists = getPlaylists();
  const active = playlists.find((p) => p.active);
  if (!active?.tracks.length) throw new Error(`${LOG} no active playlist with tracks`);
  const i = active.tracks.findIndex((t) => t.active);
  const nx = active.tracks[(i + 1) % active.tracks.length];
  for (const t of active.tracks) t.active = false;
  nx.active = true;
  await setS("playlists", playlists);
  await setCurrent(nx.url);
  return now();
}

/** Stop playback for everyone (the widget's own Stop: clears the video and every active track). */
async function stop() {
  requireWidget();
  const playlists = getPlaylists();
  for (const p of playlists) for (const t of p.tracks) t.active = false;
  await setS("playlists", playlists);
  await setS("currentVideo", "");
  return now();
}

async function setPaused(paused) {
  requireWidget();
  const player = ui.sidebarVideoPlayer?.YTPlayer;
  const ct = getS("currentTime") ?? {};
  if (player?.getVideoData) {
    // The widget's own state handler writes `currentTime` for the other clients.
    paused ? player.pauseVideo() : player.playVideo();
  } else if (ct.videoId) {
    await setS("currentTime", { videoId: ct.videoId, time: ct.time ?? 0, paused });
  } else {
    throw new Error(`${LOG} nothing is playing`);
  }
  await new Promise((r) => setTimeout(r, 400));
  return now();
}

const pause = () => setPaused(true);
const resume = () => setPaused(false);

/** What is playing right now, from the shared settings plus the GM client's player when it is rendered. */
function now() {
  requireWidget();
  const url = getS("currentVideo") || "";
  const id = parseVideoId(url);
  const ct = getS("currentTime") ?? {};
  const playlists = getS("playlists") ?? [];
  const active = playlists.find((p) => p.active);
  const track = active?.tracks.find((t) => t.active) ?? playlists.flatMap((p) => p.tracks).find((t) => t.url === url);
  const player = ui.sidebarVideoPlayer?.YTPlayer;
  let state = null, time = null, title = null;
  try {
    if (player?.getVideoData && player.getVideoData()?.video_id === id) {
      state = player.getPlayerState?.();
      time = player.getCurrentTime?.();
      title = player.getVideoData()?.title;
    }
  } catch (_) { /* player not ready */ }
  return {
    playing: !!id,
    videoId: id,
    url: id ? url : "",
    title: track?.title ?? title ?? null,
    paused: state != null ? state === 2 : (ct.videoId === id ? !!ct.paused : false),
    time: Math.round(time ?? (ct.videoId === id ? ct.time : 0) ?? 0),
    playlist: active?.name ?? null,
    autoplay: active ? active.autoplay !== false : null
  };
}

/** The Jukebox playlist's tracks, in order. */
function list() {
  requireWidget();
  const playlists = getS("playlists") ?? [];
  const jb = playlists.find((p) => p.name === playlistName());
  return {
    playlist: playlistName(),
    exists: !!jb,
    active: !!jb?.active,
    autoplay: jb ? jb.autoplay !== false : true,
    tracks: (jb?.tracks ?? []).map((t, i) => ({ n: i + 1, title: t.title, url: t.url, active: !!t.active, repeat: !!t.repeat }))
  };
}

/** Remove a track from the Jukebox playlist by id, URL or exact title. */
async function remove(input) {
  requireWidget();
  const id = parseVideoId(input);
  const playlists = getPlaylists();
  const jb = playlists.find((p) => p.name === playlistName());
  if (!jb) return list();
  const before = jb.tracks.length;
  const needle = String(input ?? "").trim().toLowerCase();
  jb.tracks = jb.tracks.filter((t) => (id ? parseVideoId(t.url) !== id : t.title.toLowerCase() !== needle));
  if (jb.tracks.length !== before) await setS("playlists", playlists);
  return list();
}

/** Volume 0-1 on THIS client only (the widget follows Foundry's playlist volume, a client setting). */
async function volume(level) {
  requireWidget();
  const v = Math.min(1, Math.max(0, Number(level) || 0));
  await game.settings.set("core", "globalPlaylistVolume", v);
  ui.sidebarVideoPlayer?.setVolume?.();
  return { volume: v, note: "GM client only; every player sets their own playlist volume" };
}

const api = { search, play, queue, next, stop, pause, resume, now, list, remove, volume, parseVideoId };

Hooks.once("ready", () => {
  const mod = game.modules.get(MOD);
  if (mod) mod.api = api;
  globalThis.PallorJukebox = api;
  if (!game.modules.get(WIDGET)?.active) console.warn(LOG, `"${WIDGET}" is not active; the API will refuse every call`);
  else console.log(LOG, "ready");
});
