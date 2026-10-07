### About this fork

This is a fork of [Jontte6/nim-to-openai-proxy](https://github.com/Jontte6/nim-to-openai-proxy), whose author has stepped back (the new upstream maintainer is [skywalker14017](https://github.com/skywalker14017/nim-to-openai-proxy)). This fork goes its own way: no model fallback, per-model handling of GLM-5.3 and DeepSeek-V4.1 thinking, longer waits for an overloaded NVIDIA, lorebooks and fixed instructions, and a test suite.

### If you forked before June 7, 2026, please pull the latest version — previous versions had an auth bypass and startup DDoS vulnerability.


### NVIDIA NIM to OpenAI Proxy
Hello, this is my first ever project on Github that I am making public. This is essentially just a translation layer between the API format that NVIDIA NIM uses to the format OpenAI uses. I made this originally by building on a script from a Reddit guide. Over the time of a month I've iterated on it, fixed problems, added auth, more models, and removed/replaced deprecated models.
These are the current available models for usage, and the use cases for all of them.

### Why use this proxy?

JanitorAI requires an OpenAI-compatible proxy to use NVIDIA NIM. SillyTavern can connect to NIM directly, but if you use **Lorebary** for prompts, lorebooks, or plugins, this proxy is necessary — Lorebary does not support NIM natively.

### Legality

Yes, it's legal. It's just HTTP requests routed through your own proxy. You still need a valid NVIDIA API key and are subject to their rate limits. This is no different from using any other API gateway or reverse proxy.


### Requirements

Node.js 24+, a NVAPI/Nim API key, a deployment platform (though if you follow the guide below none of those should be a problem).

### Model Mapping

| Alias | Backend Model | Best For | Speed | Filters |
|---|---|---|---|---|
| `nemotron-3-ultra` | `nvidia/nemotron-3-ultra-550b-a55b` | Immersive RP, the most dependable model here | Fast | Low |
| `nemotron-3-super` | `nvidia/nemotron-3-super-120b-a12b` | Lighter Nemotron. NVIDIA switched it off on Oct 3 2026 and back on a day later, so it may vanish | Fast | Low |
| `nemotron-3.5-lightning` | `nvidia/nemotron-3.5-lightning-30b-a3b` | Smallest, quickest Nemotron, 1M context (new here, not yet tested live) | Very Fast | Low |
| `deepseek-v4.1-flash` | `deepseek-ai/deepseek-v4.1-flash` | Fast replies, huge context, can read images (see below) | Fast | High |
| `glm-5.3` | `z-ai/glm-5.3` | General purpose, always thinks first (see below) | Medium-Slow | Medium |
| `glm-5.3-flash` | `z-ai/glm-5.3-flash` | Lighter, faster GLM-5.3, can read images, always thinks first | Medium | Medium |

### Renamed and removed models

If your client still uses an old name, the proxy answers with an error that says what to switch to. Change the model name in JanitorAI / SillyTavern (and reload the page).

| Old name | Use instead | Why |
|---|---|---|
| `gpt-4` | `nemotron-3-ultra` | Renamed |
| `gpt-3.5-turbo` | `nemotron-3-super` | Renamed |
| `glm-5.2` | `glm-5.3` | Renamed (NVIDIA retired GLM-5.2) |
| `gpt-4o`, `gpt-4-flash` | `deepseek-v4.1-flash` | NVIDIA retired DeepSeek V4 Pro and V4 Flash |
| `gemini-pro`, `gpt-3.5o` | `nemotron-3.5-lightning` | NVIDIA retired Llama-3.3-Nemotron-Super-49B and Nemotron-Mini-4B |

### GLM-5.3 and GLM-5.3-Flash notes

`glm-5.3` runs GLM-5.3 (it replaced GLM-5.2, which NVIDIA retired), and `glm-5.3-flash` runs GLM-5.3-Flash, a smaller and faster version that can also read images. Both always think before they reply — the models have no way to switch this off. The proxy handles it for you:

- The thinking is hidden from your chat (unless `SHOW_REASONING=true`), so you only see the reply. Expect a short pause before text starts appearing.
- Thinking length is set by `GLM_REASONING_EFFORT`. `low` (default) is fastest and fine for RP; `high` and `max` think longer and are slower.
- Thinking uses up tokens, so the proxy adds extra room on top of your max tokens setting (4096 for `low`, 8192 for `high`, 16384 for `max`) to avoid empty or cut-off replies.

### DeepSeek-V4.1-Flash notes

`deepseek-v4.1-flash` runs DeepSeek-V4.1-Flash, with a 1M-token context, and it can read images. On its own it thinks before every reply, and NVIDIA's API can hang without ever answering if a request doesn't say whether it should think. The proxy always says so:

- By default thinking is **off**, so replies start right away.
- Set `ENABLE_THINKING_MODE=true` to turn thinking on. `DEEPSEEK_REASONING_EFFORT` (`low` / `high` / `max`, default `high`) then sets how long it thinks, and the proxy adds the same extra token room as for GLM.
- As with GLM, the thinking stays hidden unless `SHOW_REASONING=true`.

### Filter Guide

| If your RP involves... | Avoid | Use instead |
|---|---|---|
| Dark themes, violence, mature content | `deepseek-v4.1-flash` (high filters due to being based in China) | `nemotron-3-ultra`, `nemotron-3-super`, `nemotron-3.5-lightning` |
| Fast responses needed | `glm-5.3`, `glm-5.3-flash` (they think before replying) | `nemotron-3.5-lightning`, `deepseek-v4.1-flash` |
| Long context / memory | — | `nemotron-3-ultra`, `glm-5.3`, `deepseek-v4.1-flash` |
| Sending images | Text-only models | `deepseek-v4.1-flash`, `glm-5.3-flash` |
| Testing / very fast replies | — | `nemotron-3.5-lightning` |

### No Fallback

The proxy only ever uses the model you asked for. If it fails, you get the error, with NVIDIA's own explanation, instead of a reply from a different model. Retries only ever go to that same model:

- Rate-limited (429) or overloaded (529): up to 2 more tries, 4 seconds apart.
- NVIDIA's server failing, bad gateway, briefly unavailable or timed out at NVIDIA's end (500 / 502 / 503 / 504), a dropped connection, or a non-streamed reply cut off halfway: 1 more try, but only if it failed within 30 seconds. A gateway timeout after minutes in NVIDIA's queue isn't worth waiting through twice.

A model name that isn't in the table above is rejected with an "Unknown model" error that lists the valid names.

### Waiting on NVIDIA

NVIDIA's free tier is often overloaded. GLM and DeepSeek have been measured taking 1 to 3+ minutes before they send the first word. The proxy is built for that:

- It waits up to **8 minutes** (`REQUEST_TIMEOUT_MS`) for NVIDIA to start answering, and allows up to 8 minutes of silence mid-reply. A reply that keeps streaming is never cut off.
- While a reply hasn't started, it sends a small "keep-alive" every 15 seconds (`KEEPALIVE_MS`): a comment line for streamed replies, a blank line before the JSON otherwise. Both are invisible in the chat. This matters on Render, which runs every service behind Cloudflare: Cloudflare drops a request that hasn't started answering within about 100 seconds, and the browser then only shows "NetworkError when attempting to fetch resource". GLM often thinks longer than that before its first word.
- If you close the chat or hit stop, the proxy cancels the request at NVIDIA too, so it doesn't eat your rate limit.

### Instructions and lorebooks

The proxy can add the same text to every chat, which is handy for private characters:

- **Instructions**: fixed rules for the bot (style, length, "never speak for the user"…). They're added after the chat history, where models follow them most closely. Set `INSTRUCTIONS_POSITION=top` to put them in the system prompt instead.
- **Lorebooks**: entries with keywords. When a keyword shows up in the last few messages, that entry's text is added to the system prompt, next to the character definition.

**Keep them private with Render's Secret Files.** This repo is public, so anything committed to it can be read by anyone. Instead:

1. In Render, open your service → **Environment** → **Secret Files** → **Add Secret File**.
2. Name it `instructions.md` and paste your instructions (start from [examples/instructions.md](examples/instructions.md)).
3. Add another one named `lorebook.json` (or `lorebook-anything.json`, as many as you like) and paste your lorebook (start from [examples/lorebook.json](examples/lorebook.json)).
4. Save and deploy. The Render log then shows `[PROMPTS] Instructions: …` and `[LORE] Loaded "…" (N entries)`, and every chat that triggers lore logs `[LORE] Added …`.

The proxy also picks up `prompts/instructions.md` and any `lorebooks/*.json` from the repo itself, but only use those for things you don't mind being public.

**Lorebook format.** Use a SillyTavern World Info export, a lorebook from a character card (Chub and most card editors), a whole V2 character card, or write one by hand like the example. For each entry:

| Field | Meaning |
|---|---|
| `keys` | Words that trigger the entry. Not case-sensitive, and they match inside longer words too ("dragon" fires on "dragons"). Write `/pattern/i` for a regex |
| `content` | The text added to the prompt |
| `constant: true` | Always added, no keywords needed |
| `secondary_keys` + `selective: true` | Also needs one of these words |
| `insertion_order` | Lower comes first. When there's too much lore, the highest numbers are kept |
| `position: "before_char"` | Put it before the character definition instead of after |
| `extensions.match_whole_words: true` | Only match whole words ("Mira" won't fire on "Miranda") |
| `case_sensitive: true` | Match upper/lower case exactly |

At the top level, `"characters": ["Mira", "Kael"]` limits a lorebook to chats whose character definition mentions one of those names, and `scan_depth` sets how many recent messages that book checks. A book's own `scan_depth` wins over `LOREBOOK_SCAN_DEPTH` (default 4), and the startup log shows it. At most about 2048 tokens of lore are added per message (`LOREBOOK_TOKEN_BUDGET`). `{{char}}` and `{{user}}` are not filled in, so write names out. Probability and recursive triggering from SillyTavern are not supported: matched entries are always added.

### Auth Guide
I added auth middleware that wasn't present in the code I built upon. It uses an env var in your deployment. Use any random string of 32+ characters, for example one generated by a password manager. Don't paste your NVIDIA key into an online hash tool to make one: that hands the key to a stranger's website. Make an env variable called "CLIENT_AUTH_KEY" with that string, and enter the same string into the API Key field in JanitorAI/SillyTavern.

### Proxy Setup Guide

Firstly head to https://build.nvidia.com/ and login/create an account. Then click your profile icon and navigate to "API keys". There you can generate an API key, and label it whatever you want. Save it immediately — you'll need to regenerate it if lost.

You *can* use basically any service that allows cloud deployments/VMs with a static IP, but I recommend Railway, Render, and Vercel. Possibly Oracle if you are comfortable with SSH and value the freedom it gives, but Railway is the easiest to setup.
You need to login to Railway with your Github. **Fork the repo before deploying. I cannot see your env vars, but forking ensures your deployment is fully isolated!** This prevents me (or anyone) from seeing your deployment in Railway's dashboard or through github. I also recommend making sure deployments aren't visible on the frontpage.
After you have made a deployment, you need to wait around 3 minutes for it to finish deploying. Then go into the "variables" tab, and create an env var with the name "NIM_API_KEY", and enter your NVAPI key into the variable. Next in your deployment go to the settings page, and there the networking section. Generate a public URL for your deployment. This is necessary to access it. Now your proxy is ready.

### Important Information
You can check the status of your proxy with the "/health" endpoint, and a list of models with "/v1/models". These endpoints intentionally do not require the auth, so clients can verify connectivity before configuring auth.
Your actual chat endpoint is in "/v1/chat/completions", and is the one you use in Janitor AI/SillyTavern or whatever platform you use.
The client never sees your NVAPI key, which is why we don't use it as the auth, since the whole point of the auth configuration is so that your NVAPI key is not stored on your client.

### Optional Environment Variables

After deploying, you can set these in your host's environment settings (Render: **Environment**, Railway: **Variables**):

| Variable | Value | Effect |
|---|---|---|
| `SHOW_REASONING` | `true` | Shows model reasoning in `<thinking>` tags |
| `ENABLE_THINKING_MODE` | `true` | Turns thinking on for `deepseek-v4.1-flash` |
| `DISCORD_WEBHOOK_URL` | Webhook URL | Alerts you when models fail validation |
| `SKIP_VALIDATION` | `true` | Disables startup model checks |
| `GLM_REASONING_EFFORT` | `low` / `high` / `max` | How long `glm-5.3` and `glm-5.3-flash` think before replying (default `low`) |
| `DEEPSEEK_REASONING_EFFORT` | `low` / `high` / `max` | How long `deepseek-v4.1-flash` thinks when `ENABLE_THINKING_MODE=true` (default `high`) |
| `REQUEST_TIMEOUT_MS` | milliseconds | How long to wait for NVIDIA, for every model (default `480000` = 8 minutes): both for it to start answering and for the longest silence in the middle of a reply. A reply that keeps streaming is never cut off |
| `KEEPALIVE_MS` | milliseconds | How often a waiting reply gets an invisible keep-alive (default `15000`; `0` turns it off). Keep it well under 100 s on Render |
| `INSTRUCTIONS_POSITION` | `bottom` / `top` | Where the instructions go: after the chat (default) or in the system prompt |
| `INSTRUCTIONS_PATH` | file path | Check this file for instructions first, before the usual places |
| `LOREBOOK_PATH` | file or folder paths, comma-separated | Extra lorebooks to load |
| `LOREBOOK_SCAN_DEPTH` | number | How many recent messages are checked for lorebook keywords (default `4`; a book's own `scan_depth` wins) |
| `LOREBOOK_TOKEN_BUDGET` | number | Roughly how many tokens of lore can be added per message (default `2048`) |


For the `true` switches, set `false` or remove the variable to turn them off; `KEEPALIVE_MS=0` turns keep-alive off. The proxy reads these when it starts, so a change takes effect after the next deploy (on Render, "Save and deploy"). A value it can't use is ignored with a warning in the log.

### Troubleshooting

| Problem | Likely Cause | Fix |
|---|---|---|
| "NVIDIA NIM error 401 (…)" | `NIM_API_KEY` invalid or expired | Regenerate the key at build.nvidia.com and update `NIM_API_KEY` |
| "NVIDIA NIM error 404 (model): NVIDIA is not serving this model…" | NVIDIA had nothing to serve that model with your key at that moment (pulled, briefly unavailable, or not enabled for your account) | Try again a bit later or pick another model. If it never works for that model, check your build.nvidia.com account |
| "NVIDIA NIM error 500 (model): Internal error while making inference request…" | NVIDIA's own server failed while writing the reply (the proxy already retried once) | Usually temporary: regenerate, or switch models for a while |
| "Unknown model" / "has been renamed" / "was removed" error | Model name in your client isn't in the Model Mapping table | Use the name the error suggests, or one from the table, e.g. `glm-5.3` |
| Very slow responses | Using `glm-5.3` / `glm-5.3-flash` (they think first) or Chinese models during peak hours | Switch to `nemotron-3.5-lightning` or `nemotron-3-ultra` |
| "NVIDIA did not start answering within 480s" | NVIDIA's free tier is overloaded for that model (common for `deepseek-v4.1-flash` and the GLMs) | Try again later or switch models — the proxy never swaps models for you |
| "NVIDIA NIM error 410 (model): … reached its end of life" | NVIDIA retired that model | Pick another model; the error names the retired one |
| Filter interrupts RP | Using Chinese-hosted model for mature content | Use one of the `nemotron-…` models |
| "Forbidden: Invalid or missing authentication" (403) | The API key in your client doesn't match `CLIENT_AUTH_KEY` | Make them identical, then reload the client page |
| "A network error occurred… NetworkError when attempting to fetch resource", only with slow models (GLM) | Render's Cloudflare edge cut a reply that hadn't started within ~100 s | Fixed by the keep-alive above; make sure `KEEPALIVE_MS` isn't `0` |
| "Failed to fetch (unk)" / "A network error occurred" | JanitorAI cached old proxy config after changing URL or model | **Reload the page** — changes don't apply until refresh |

**A reply fails after a while?** Your host's log (Render: **Logs**) says which side gave up:

| Log line | Meaning |
|---|---|
| `NVIDIA did not start answering within …` | NVIDIA never started; it's overloaded |
| `NVIDIA NIM error 504` / `503` / `502` / `500` | NVIDIA's gateway gave up, was down, or its server failed |
| `NVIDIA's reply was cut off before it finished` | NVIDIA dropped a non-streamed reply halfway |
| `[STREAM] Upstream error` | NVIDIA went silent or dropped the connection mid-reply |
| `Client disconnected before NVIDIA answered` / `before the reply finished` | Your client (JanitorAI) gave up or you pressed stop |


### Testing

`npm test` runs the proxy against a fake NVIDIA API on your machine. It checks that each model gets the right settings, that replies come through cleanly (streamed or not), and that thinking never leaks into the reply. No API key or internet needed.

`npm run smoke` checks a running proxy against the real NVIDIA API. It asks every model for a one-word reply, normally and streamed:

```
PROXY_URL=https://your-app.up.railway.app CLIENT_AUTH_KEY=your-key npm run smoke
```

`PROXY_URL` defaults to `http://localhost:3000`. Set `MODELS=glm-5.3-flash,nemotron-3-ultra` to check only some models.

## Contributing

This is a personal hobby project I built for my own use, but I'm happy if it helps others. If you spot a bug, want to suggest a model mapping, or have a small improvement, feel free to open an issue or PR. I can't promise fast responses since I maintain this in my free time, but I'll do my best.

### What I'm open to
- Model mapping updates (NIM deprecates things constantly)
- Bug fixes
- Small feature additions that don't complicate the core flow
- Documentation improvements

### What I'm less likely to merge
- Major architectural changes (I want to keep this simple)
- Features I don't personally use (harder for me to maintain)
- Anything that adds complexity without clear benefit

## Issues

Before opening an issue, check if it's already covered in the [Troubleshooting](#troubleshooting) section. If a model stopped working, it's probably deprecated by NVIDIA — check the [NIM catalog](https://build.nvidia.com/) first.

When reporting bugs, include:
- Which model alias you were using
- Whether streaming was enabled
- The error message
- Your deployment platform (Railway, Render, etc.)

## Contact
Need to reach out faster? Add me on discord `Jonttex`.

## Disclaimer

I am not a professional developer. This project was built with help from AI tools and community guides. It works for me, but your mileage may vary. Use at your own risk. I am still learning JS, so the speed at which I am able to fix issues, and respond to them will vary depending on the type of issue, and how common it is.
