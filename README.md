# LiveCC Pages Single Room

一个适合直接放到 Cloudflare Pages 的单房间直播页：

- 同一个固定网址
- 主播点击“开始投屏”后，页面会把当前直播状态写入 Pages KV
- 其他观众访问同一个网址时，会自动检测当前直播并开始观看
- Realtime secret 保存在 Pages Functions 环境变量里，不暴露到前端

## 你需要配置的东西

### 1. Pages 环境变量 / Secrets

- `REALTIME_APP_ID`
  普通文本
- `REALTIME_APP_SECRET`
  Secret
- `HOST_TOKEN`
  可选，建议 Secret

### 2. Pages KV 绑定

创建一个 KV Namespace，并在 Pages 项目里绑定成：

```text
LIVE_STATE
```

## 使用方式

1. 把这个文件夹作为 Pages 项目根目录
2. 配好上面的环境变量和 KV
3. 主播打开同一个 Pages 地址
4. 如果配置了 `HOST_TOKEN`，先输入管理密钥
5. 点击“开始投屏”
6. 观众访问同一个网址，会自动检测并观看当前直播
