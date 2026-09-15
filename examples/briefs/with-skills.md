# 添加健康状态文件

先审查本需求是否可验证，再在仓库根目录创建 `example-health.txt`，内容恰好为 `ok` 和一个换行符。

验收命令：`test "$(cat example-health.txt)" = ok`。
