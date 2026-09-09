# AI STV VM Bot — Zalo

Bot Zalo (tài khoản cá nhân) tạo **Windows VM tạm thời** qua GitHub Actions.

## Chức năng

| Lệnh | Mô tả |
|------|-------|
| `tvm [số_phút] [số_máy]` | Tạo Windows VM (mặc định 60 phút, 1 máy, tối đa 355 phút / 5 máy) |
| `idnhom` | Lấy **ID nhóm** hiện tại (gõ trong nhóm cần lấy) |
| `myid` | Lấy ID Zalo của bạn |
| `huongdan` | Hướng dẫn sử dụng |
| `luat` | Luật sử dụng máy ảo |

Sau khi tạo máy xong, thông tin đăng nhập (IP Tailscale, username, password RDP) được gửi **trực tiếp vào nhóm** nơi bạn gõ lệnh — kèm cảnh báo hết hạn 30/15/5 phút trước khi máy bị gỡ.

## Cài đặt

```bash
npm install
node index.js
```

Yêu cầu Node.js >= 18.

## Cấu hình (`bot_config.json`)

```json
{
  "zalo_imei": "<IMEI từ Zalo Web>",
  "zalo_cookie": { "zi": "...", "zpsid": "...", "zpw_sek": "..." },
  "zalo_user_agent": "<userAgent trình duyệt>",
  "admin_github_token": "<GitHub PAT có quyền repo + workflow>",
  "admin_tailscale_key": "<Tailscale auth key>",
  "github_repo": "aistv-vm-worker",
  "github_owner": ""
}
```

### Cách lấy thông tin đăng nhập Zalo (IMEI + cookie)

1. Đăng nhập [chat.zalo.me](https://chat.zalo.me/) trên trình duyệt
2. Nhấn **F12** → tab **Console**, gõ `localStorage.getItem('z_uuid')` để lấy **IMEI**
3. Gõ `navigator.userAgent` để lấy **userAgent**
4. Lấy cookie bằng tiện ích [ZaloDataExtractor](https://github.com/JustKemForFun/ZaloDataExtractor) hoặc Cookie-Editor
   - Cookie dạng mảng (export Cookie-Editor) hoặc object phẳng `{ "zi": "...", "zpsid": "..." }` đều dùng được

> ⚠️ Cookie sẽ hết hạn theo thời gian — khi bot báo lỗi đăng nhập, hãy lấy lại cookie mới.
> ⚠️ Đây là API không chính thức — tài khoản Zalo có thể bị khóa. Cân nhắc dùng tài khoản phụ.

### Cách lấy GitHub token mới

1. Vào https://github.com/settings/tokens → **Generate new token (classic)**
2. Chọn scope: **repo** + **workflow**
3. Dán vào `admin_github_token` trong `bot_config.json`

## Cơ chế gửi thông tin máy

- **Có URL công khai** (deploy Railway/Render): đặt `bot_webhook_url` + `bot_webhook_secret` → GitHub Actions POST creds về bot tức thì.
- **Chạy local**: để trống `bot_webhook_url` → bot tự **poll artifact** `vm-creds.json` từ GitHub mỗi 30 giây (từ phút thứ 2 sau khi tạo).

## Deploy (Railway)

`railway.json` đã cấu hình sẵn Dockerfile + healthcheck `/health`. Bot tự phát hiện `RAILWAY_PUBLIC_DOMAIN` qua biến môi trường `BOT_WEBHOOK_URL` nếu cần.

## Cấu trúc

```
index.js               — Bot chính (login Zalo, lệnh, tạo VM, webhook, monitor)
src/config.js          — Đọc cấu hình
src/store.js           — Lưu trữ JSON (vm_bot_data/)
src/github.js          — GitHub API + provisioning repo worker
worker_templates/      — Workflow + scripts đẩy lên repo worker
```
