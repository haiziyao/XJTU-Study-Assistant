"""后台启动 dschat，不弹浏览器。

`app/server.py:1512` 在 main() 里固定会 `webbrowser.open(url)`，没有开关。
后台/隐藏窗口启动时它会在你桌面上凭空弹一个浏览器标签，很讨厌。
这里在调用前把 webbrowser.open 换掉 —— 不改 dschat 本体，它自己的行为不变。
"""
import os
import runpy
import sys
import webbrowser

BASE = r"E:\WHYidea\dschat"
os.chdir(BASE)
sys.path.insert(0, BASE)

webbrowser.open = lambda *a, **k: False          # 后台启动，别弹浏览器
webbrowser.open_new = lambda *a, **k: False
webbrowser.open_new_tab = lambda *a, **k: False

runpy.run_path(os.path.join(BASE, "chattest.py"), run_name="__main__")
