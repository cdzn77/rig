-- Rig launcher. Compiled into Rig.app by launcher/build-app.sh.
-- Click the Dock icon: starts Rig if needed, then opens the dashboard.
-- Quit from the Dock: stops every Rig server and confirms port 4545 is closed.
-- If this app crashes or is force-quit, the server notices within 3 seconds
-- and shuts itself down.

property rigDir : "__RIG_DIR__"
property rigURL : "http://127.0.0.1:4545"

on run
	launchRig()
end run

-- Clicking the Dock icon while Rig.app is already running.
on reopen
	launchRig()
end reopen

on quit
	try
		do shell script "/bin/bash " & quoted form of (rigDir & "/launcher/stop-server.sh")
	end try
	continue quit
end quit

on launchRig()
	if not rigIsUp() then
		-- $PPID in a do shell script is this app's own process ID.
		set appPID to do shell script "echo $PPID"
		do shell script "/bin/bash " & quoted form of (rigDir & "/launcher/start-server.sh") & " " & appPID & " > /dev/null 2>&1 &"
		set ready to false
		repeat 60 times
			delay 0.25
			if rigIsUp() then
				set ready to true
				exit repeat
			end if
		end repeat
		if not ready then
			display alert "Rig didn't start" message "Details are in ~/Library/Logs/Rig.log. The usual causes are Node not being found, or another app already using port 4545." as warning
			return
		end if
	end if
	open location rigURL
end launchRig

on rigIsUp()
	try
		do shell script "/usr/bin/curl -s -o /dev/null -m 1 " & rigURL & "/api/snapshot"
		return true
	on error
		return false
	end try
end rigIsUp
