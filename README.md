# Pallor Jukebox

A small API over theripper93's **Youtube Player Widget** (`fvtt-youtube-player`) so an assistant (Claude Code or Codex through Claude Bridge) or a macro can search YouTube and play music for the whole table.

The widget already plays whatever its world setting `currentVideo` holds and keeps playlists in its `playlists` setting. Pallor Jukebox only drives those settings: nothing is duplicated, and everything you do through the API shows up in the widget as if you had clicked it.

## Requirements

- Foundry VTT 13 or 14
- **Youtube Player Widget** 4.x, active, with a Google API key entered in its settings (the key is used for the YouTube Data API search)
- GM client (the widget's settings are world settings)

## API

```js
const jb = game.modules.get("pallor-jukebox").api;   // also globalThis.PallorJukebox

await jb.search("medieval tavern ambience", { max: 5, minMinutes: 30 });
// -> [{ id, url, title, channel, seconds, duration, embeddable }, ...]

await jb.play("vyg5jJrZ42s");                         // id or any YouTube URL; plays now for everyone
await jb.play(url, { title: "Tavern", loop: true });  // optional title and repeat
await jb.play(url, { save: false });                  // play without touching the Jukebox playlist
await jb.queue(url);                                  // add to the Jukebox playlist, keep playing
await jb.next();                                      // next track of the active playlist
await jb.pause();  await jb.resume();  await jb.stop();
jb.now();   // { playing, videoId, url, title, paused, time, playlist, autoplay }
jb.list();  // the Jukebox playlist's tracks in order
await jb.remove(urlOrIdOrTitle);
await jb.volume(0.4);                                 // this client only
```

`play` and `queue` keep their tracks in a playlist called **Jukebox** (rename it in the module settings). `play` makes it the active playlist and marks the track active, so the widget's autoplay continues from there.

## Settings

- **Jukebox playlist name** (world): the playlist used by `play` and `queue`. Default `Jukebox`.
- **Default minimum length** (world): `search` drops shorter videos unless the call passes `minMinutes`. Default 0.

## Install

Upload the packaged zip to The Forge, or paste the manifest URL into Foundry's **Install Module** dialog:

`https://github.com/teshaman/pallor-jukebox/releases/latest/download/module.json`

## Licence

MIT. The GM claims no ownership of the code.
