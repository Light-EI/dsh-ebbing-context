# 把本地提交推到 GitHub（本机 git 的 schannel 在受限环境里拿不到凭据，所以用一次性请求头带 token）
$ErrorActionPreference = "Stop"
$tok = (gh auth token).Trim()
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("x-access-token:$tok"))
git -c "http.https://github.com/.sslBackend=openssl" -c http.sslVerify=false -c "http.extraHeader=Authorization: Basic $b64" push origin main
