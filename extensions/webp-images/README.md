# WebP Images

Optional and off by default. When enabled, images are re-encoded as lossy WebP as they enter the conversation. On a sample of 767 session screenshots, WebP at quality 80 was 74% smaller than the PNG and JPEG files Pi stores, with nearly the same structural similarity (0.984 against 0.990). Image token counts depend on pixel size, not format, so the savings are in request and session size.

Each image is converted once, before it is stored: images you attach, and images in tool results such as `read`. Earlier messages never change afterwards, so the provider's prompt cache keeps working. Images already in a session stay as they are.

- Output stays within the active model's image limits (`inputLimits.images.resize`, or Pi's defaults), so Pi keeps the WebP instead of re-encoding it. When that shrinks an image, Pi's own note with the original size and scale factor is added, as Pi does when it resizes, so the model still knows the true dimensions.
- A `read` result is encoded from the original file at the size Pi chose, with EXIF rotation applied, so the WebP is not a copy of a copy. A file whose shape does not match the image is ignored.
- GIFs and animated images stay as they are, because WebP output keeps only the first frame. So does any image whose WebP would not be smaller.
- An image that cannot be converted keeps its original format, with a warning. If the `sharp` library cannot load on a platform, the extension reports it once and does nothing.

## Models that reject WebP

Some providers accept only JPEG and PNG; xAI documents that for Grok. For each request to a model outside `webpModels`, WebP images are sent as JPEG (PNG when transparent) instead. The conversion is deterministic and cached in memory, so repeated requests send identical bytes and keep the prompt cache; the session itself is unchanged. This fallback runs even when conversion is off, because sessions keep their WebP images and you can attach WebP files yourself.

## Configuration

`<agent-dir>/webp-images.json`:

```json
{
  "enabled": true,
  "quality": 80,
  "webpModels": ["claude", "gpt", "gemini"]
}
```

`quality` is 1 to 100. `webpModels` lists case-insensitive parts of `provider/model-id` for models that accept WebP; any other model receives JPEG or PNG. Changes apply after `/reload` or a restart.
