# Media Understanding

Optional helper models for images, video, and audio. Every part is off by default and turns on by itself in `<agent-dir>/media-understanding.json`; a tool exists only while its part is enabled, so unused parts add nothing to the model's tool list.

## Images

`images.enabled` registers `view_image`, plus `ask_image` when `images.model` is set.

- `view_image` shows an image file to the main model, resized to the model's image limits with Pi's size note. A `region` of `[x1, y1, x2, y2]` in the original image's pixels crops before any downscaling, so the agent can zoom into small text at full resolution. The same image and region can be shown `maxViewsPerImage` times per session (default 3, 0 for unlimited), which stops loops that reload one screenshot again and again. A model that cannot see images gets a message pointing to `ask_image` instead.
- `ask_image` asks the image model a question about a file or a region of it and returns text, without adding the image to the conversation.

`images.describeOnArrival` replaces images with the image model's description as they enter the conversation: `"auto"` only for models that cannot take images, `"always"` for every model. The swap happens once, before the message is stored: attachments are described into your message, and images in tool results become text. Earlier messages never change afterwards, so the prompt cache keeps working. Each described image is saved under `<agent-dir>/media-understanding/` (the original file for `read` results, so zooming has full resolution) and its description names that file for `view_image` and `ask_image`. Saved copies older than 30 days are removed at session start. An image whose description fails stays an image, with a warning. The description prompt includes the user's latest message or the tool call that produced the image and asks for legible text verbatim.

## Video and audio

`video.enabled` registers `ask_video`, and `audio.enabled` registers `ask_audio`. Each sends one file and a question to its model and returns the answer as text; the media never enters the conversation.

- Video: mp4, mpeg, mpg, mov, avi, flv, webm, wmv, 3gp. Audio: wav, mp3, aiff, aac, ogg, flac. Other formats are refused with a hint to convert them with ffmpeg.
- Files over `maxFileMB` (default 20) are refused with a hint to trim or compress them. This is the extension's own limit, not a measured provider limit.
- Pi's request types carry only text and images, so these tools send an OpenAI Responses request with the file as an `input_file` data URL, using Pi's credentials and base URL for the configured model. The model must use the `openai-responses` API and accept the media; CLIProxy's Antigravity Gemini route does.

## Configuration

```json
{
  "images": {
    "enabled": true,
    "describeOnArrival": "auto",
    "model": "provider/model-id",
    "thinkingLevel": "low"
  },
  "video": { "enabled": true, "model": "provider/model-id", "thinkingLevel": "low" },
  "audio": { "enabled": true, "model": "provider/model-id", "thinkingLevel": "low" },
  "maxFileMB": 20,
  "maxViewsPerImage": 3
}
```

`describeOnArrival` is `off` (default), `auto`, or `always`, and needs `images.model`. `thinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; the model's own mapping decides the effort it receives. A part that is enabled without a model warns at session start. Changes apply after `/reload` or a restart.

Image compression is separate: Pi encodes images using the model catalog's `inputLimits.images.resize`, and the WebP Images extension stores them as WebP.
