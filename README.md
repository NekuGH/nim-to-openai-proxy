### Announcement 
Due to personal health I will no longer be able to maintain this project. It has been fun and hearing feedback from a bunch of you has helped me maintain it, but I will be stopping here. If someone is interested in continuing to maintain this, you can reach out to me on discord and I'll add a link here to refer to your repo.



### If you forked before June 7, 2026, please pull the latest version — previous versions had an auth bypass and startup DDoS vulnerability.

### Guys. Just don't use reasoning at this point. There's not a single standard that nim follows that I could make use of. The reasoning on one model works, then I fix it for the other and the first breaks.


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
| `nemotron-3-ultra` | `nvidia/nemotron-3-ultra-550b-a55b` | Immersive RP | Fast | Low |
| `gpt-4o` | `deepseek-ai/deepseek-v4-pro-0813` |
| `gpt-4-flash` | `deepseek-ai/deepseek-v4-flash` | Fast, non-edgy RP | Fast | High |
| `deepseek-v4.1-flash` | `deepseek-ai/deepseek-v4.1-flash` | Fast replies, huge context, can read images (see below) | Fast | High |
| `gpt-3.5o` | `nvidia/nemotron-mini-4b-instruct` | Lightweight RP, fast responses | Very Fast | Low |
| `gemini-pro` | `nvidia/llama-3.3-nemotron-super-49b-v1.5` | Daily driver, low latency | Fast | Low |
| `glm-5.3` | `z-ai/glm-5.3` | General purpose, always thinks first (see below) | Medium-Slow | Medium |
| `glm-5.3-flash` | `z-ai/glm-5.3-flash` | Lighter, faster GLM-5.3, can read images, always thinks first | Medium | Medium |
| `gpt-3.5-turbo` | `nvidia/nemotron-3-super-120b-a12b` | Lightweight tasks | Fast | Low |

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
| Dark themes, violence, mature content | `gpt-4o`, `gpt-4-flash`, `deepseek-v4.1-flash` (They have high filters due to being based in China) | `nemotron-3-ultra`, `gemini-pro`, `gpt-3.5-turbo` |
| Fast responses needed | `glm-5.3`, `glm-5.3-flash` (they think before replying) | `gemini-pro`, `gpt-3.5o`, `deepseek-v4.1-flash` |
| Long context / memory | Anything under 30B | `nemotron-3-ultra`, `glm-5.3`, `deepseek-v4.1-flash` |
| Sending images | Text-only models | `deepseek-v4.1-flash`, `glm-5.3-flash` |
| Testing / very fast replies | — | `gpt-3.5o` |

### No Fallback

The proxy only ever uses the model you asked for. If it fails, you get the error instead of a reply from a different model. The only retry is on that same model: up to 2 more tries when NVIDIA is rate-limiting (429) or overloaded (529).

A model name that isn't in the table above is rejected with an "Unknown model" error that lists the valid names.

### Auth Guide
I added auth middleware that wasn't present in the code I built upon. It uses an env var in your deployment. Use any secure string of 32+ characters, or generate one by hashing your NVAPI key. I recommend using an online hash tool or command to make a hash of your NVAPI key since the key is already complex as is, and a hash makes it more secure as it cannot be realistically reversed back to the NVAPI key. The first 32 characters of the hash are enough.
You can easily generate the hash with an online SHA-256 generator or any hash tool. Then make an env variable called "CLIENT_AUTH_KEY" and enter the first 32 characters of your hash into the variable (or any custom length over 16, or a custom key). Enter the hash into the API Key field in JanitorAI/SillyTavern.

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

After deploying, you can set these in Railway's **Variables** tab:

| Variable | Value | Effect |
|---|---|---|
| `SHOW_REASONING` | `true` | Shows model reasoning in `<thinking>` tags |
| `ENABLE_THINKING_MODE` | `true` | Sends thinking parameters to supported models; turns thinking on for `deepseek-v4.1-flash` |
| `DISCORD_WEBHOOK_URL` | Webhook URL | Alerts you when models fail validation |
| `SKIP_VALIDATION` | `true` | Disables startup model checks |
| `GLM_REASONING_EFFORT` | `low` / `high` / `max` | How long `glm-5.3` and `glm-5.3-flash` think before replying (default `low`) |
| `DEEPSEEK_REASONING_EFFORT` | `low` / `high` / `max` | How long `deepseek-v4.1-flash` thinks when `ENABLE_THINKING_MODE=true` (default `high`) |


Set to `false` or remove to disable. Changes apply without redeploying.

### Troubleshooting

| Problem | Likely Cause | Fix |
|---|---|---|
| "Request failed with status code 401" error | NIM API key invalid or expired | Regenerate key at build.nvidia.com |
| "Unknown model" error | Model name in your client isn't in the Model Mapping table | Use one of the aliases from the table, e.g. `glm-5.3` |
| Very slow responses | Using `glm-5.3` / `glm-5.3-flash` (they think first) or Chinese models during peak hours | Switch to `gemini-pro` or `gpt-3.5o` |
| "timeout of 180000ms exceeded" | NVIDIA's free tier is overloaded for that model (common for new models like `deepseek-v4.1-flash` and `glm-5.3-flash`) | Try again later or switch models — the proxy never swaps models for you |
| Filter interrupts RP | Using Chinese-hosted model for mature content | Use `nemotron-3-ultra`, `gemini-pro`, or `gpt-3.5-turbo` |
| 404 on `/v1/chat/completions` | Auth mismatch | Verify `CLIENT_AUTH_KEY` matches between Railway and client |
| "Failed to fetch (unk)" / "A network error occurred" | JanitorAI cached old proxy config after changing URL or model | **Reload the page** — changes don't apply until refresh |


### Testing

`npm test` runs the proxy against a fake NVIDIA API on your machine. It checks that each model gets the right settings, that replies come through cleanly (streamed or not), and that thinking never leaks into the reply. No API key or internet needed.

`npm run smoke` checks a running proxy against the real NVIDIA API. It asks `deepseek-v4.1-flash`, `glm-5.3` and `glm-5.3-flash` for a one-word reply, normally and streamed:

```
PROXY_URL=https://your-app.up.railway.app CLIENT_AUTH_KEY=your-key npm run smoke
```

`PROXY_URL` defaults to `http://localhost:3000`. Set `MODELS=glm-5.3-flash,nemotron-3-ultra` to pick other aliases.

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
