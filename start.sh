#!/bin/sh
echo "Serving on http://127.0.0.1:8778  (ES modules will not load over file://)"
python3 -m http.server 8778 --bind 127.0.0.1
