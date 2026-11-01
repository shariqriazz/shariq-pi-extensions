# Image Descriptions

Optional and off by default. When enabled, images are replaced with a text description from a vision model as they enter the conversation, so the main model's history holds text instead of image data. Long screenshot-heavy sessions stay small, compaction sees text it can summarize, and request size limits rarely matter.

The swap happens once, before an image is stored: images you attach are described into your message, and images in tool results (such as `read` on a screenshot) become text in that result. Earlier messages never change afterwards, so the provider's prompt cache keeps working. Images in sessions from before the extension was enabled stay as they are.

Each image is saved under `<agent-dir>/image-descriptions/` and its description names that file, so later questions see the same image even if the original file changed. Saved copies older than 30 days are removed at session start. An image whose description fails stays an image, with a warning.

The vision model gets the user's latest message, or the tool call that produced the image, so the description focuses on what the agent needs. It transcribes legible text exactly.

## Tools

- `ask_image` asks the vision model a question about an image file and returns the answer as text.
- `view_image` shows an image file to the main model directly, resized by the main model's image limits, for the rare case a description is not enough. Its result is not replaced.

Both are registered only when the extension is enabled.

## Configuration

`<agent-dir>/image-descriptions.json`:

```json
{
  "enabled": true,
  "model": "provider/model-id",
  "thinkingLevel": "low"
}
```

`model` must be an image-capable model in Pi's model registry. `thinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; the model's own mapping decides the effort it receives. Changes apply after `/reload` or a restart.

Compression is separate: Pi encodes images at arrival using the model catalog's `inputLimits.images.resize`.
