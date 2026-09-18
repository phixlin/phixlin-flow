# 修复错误内容

在仓库根目录创建 `example-repair.txt`。Build 首次写入 `wrong`，Verify 必须执行 `test "$(cat example-repair.txt)" = fixed`；失败后回到 Build，将内容修复为 `fixed` 并再次验证。
