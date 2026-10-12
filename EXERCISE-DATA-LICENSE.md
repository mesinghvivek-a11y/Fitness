# Exercise catalogue source and licence notes

## Upstream metadata source

The 1,324 imported exercise metadata records are derived from:

- Repository: https://github.com/hasaneyldrm/exercises-dataset
- Upstream licence: MIT, Copyright (c) 2026 Hasan Emir Yıldırım
- Upstream README: https://github.com/hasaneyldrm/exercises-dataset/blob/main/README.md

The MIT licence applies to the upstream code, dataset structure, exercise metadata and instruction text/translations, subject to the media exception below. Retain this attribution/licence note when distributing derived exercise metadata.

### MIT licence notice (upstream data)

Copyright (c) 2026 Hasan Emir Yıldırım

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation and data files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Media exception — important

The source dataset's `images/` thumbnails and `videos/` GIF animations are **not covered by the MIT licence**. The upstream repository identifies them as © Gym visual and states that users must follow Gym Visual's terms and obtain any required permission/licence for their own use. The media files are not included in this Timely Fit bundle.

- Rights holder: © Gym visual — https://gymvisual.com/
- Terms: https://gymvisual.com/content/3-terms-and-conditions-of-use
- Upstream notice: https://github.com/hasaneyldrm/exercises-dataset/blob/main/NOTICE.md

Do not add or publicly serve the source thumbnails/GIFs unless your planned use is permitted. If licensed, place files at the relative paths specified by `image` and `gif_url` under `exercise-media/`, then mark the corresponding record `media_status: "licensed"`. Keep the rights holder attribution where required by the licence.
