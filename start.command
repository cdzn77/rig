#!/bin/bash
# Double-click in Finder to start Rig and open it in your browser.
cd "$(dirname "$0")"
( sleep 1.5 && open "http://127.0.0.1:4545" ) &
exec node server.js
