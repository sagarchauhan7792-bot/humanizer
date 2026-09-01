@echo off
echo Serving on http://127.0.0.1:8778  (ES modules will not load over file://)
python -m http.server 8778 --bind 127.0.0.1
