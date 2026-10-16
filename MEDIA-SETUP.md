# Exercise images and animations

All 1,324 imported exercises are now marked `"media_status": "licensed"` in `exercises.json`.
The app shows the image and animation only when the files exist at the paths stored in each record:

- thumbnail: the record's `image` path, for example `exercise-media/images/0001-2gPfomN.jpg`
- animation: the record's `gif_url` path, for example `exercise-media/videos/0001-2gPfomN.gif`

If a file is missing, the app quietly shows the muscle icon instead. Nothing breaks.
Keep your licence documentation with the project; only mark records `licensed` for media you have the right to use.
