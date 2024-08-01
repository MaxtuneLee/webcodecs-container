# WebCodec 无头浏览器环境

在 windows 上暴露了 createVideo 方法，可以在 puppeteer 的无头浏览器环境中直接调用，内部封装了 webcodecs 所需的 mp4box 能力以及 chrome key 处理等能力

## 建议的使用方法

由于 puppeteer 和 node 通信限制，无法直接传输大文件，所以不建议直接通过 page.evaluate 传输视频文件，建议通过网络请求传输视频文件

先把视频文件保存到服务器某个目录，然后在无头浏览器环境中通过网络请求下载视频文件，然后再调用 createVideo 方法生成视频，保存到指定目录

最后在 node 服务中再通过网络请求下载生成的视频文件