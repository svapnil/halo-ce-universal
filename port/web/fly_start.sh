#!/bin/sh
# Starts the machine's two servers (Dockerfile, fly.toml; NETWORK.md, "The
# machine"): the relay of native games, and beside it the signalling of games
# between browsers.
#
# The relay carries games' packets, and the machine has one CPU: the
# signalling runs at the lowest priority (and its Erlang does not spin:
# signalling/rel/vm.args.eex), so it runs only when the relay does not. If it
# ends it is started again, and the relay's games go on; if the relay ends,
# the machine does, and Fly starts it again.

# (no other Erlang reaches this one; and what a release writes as it starts
# goes where this user may write)
export RELEASE_DISTRIBUTION=none RELEASE_TMP=/tmp

(
	while true; do
		nice -n 19 /signalling/bin/signalling start
		echo "signalling: ended ($?), starting again"
		sleep 2
	done
) &

exec /relay
