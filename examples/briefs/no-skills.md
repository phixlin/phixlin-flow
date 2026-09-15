# 添加版本文件

在仓库根目录创建 `example-version.txt`，内容恰好为 `v1` 和一个换行符。

验收命令：`test "$(cat example-version.txt)" = v1`。
