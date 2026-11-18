// 在页面脚本执行前注入：伪造原生桥，用来在浏览器里预览「更新提示条」
window.HmsBridge = {
  version: () => JSON.stringify({ versionCode: 4, versionName: '1.3.0' }),
  checkUpdate: () => {
    setTimeout(() => {
      if (typeof window.__hmsUpdate === 'function') {
        window.__hmsUpdate({
          ok: true,
          versionCode: 5,
          versionName: '1.4.0',
          notes: '新增 App 内更新：收到提示后点一下就能装新版',
          url: 'https://obiectstudy.github.io/hms/dist/HMS-latest.apk',
          sha256: 'e66790748d08eee630806cf33692a08b24424e8910f5556f78228aa1ed6ffc45',
          size: 1710227,
        });
      }
    }, 400);
  },
  installUpdate: (json) => { window.__installCalledWith = json; },
};
