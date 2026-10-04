/*
PROBE_PORTS.MJS

Checks a deployed relay's UDP ports, as pages use them: for each session
(one port each), a token from the site's Worker, a STUN request through the
relay (which tells the session's port and public address), a datagram from
the relay to this machine (which lets this machine's address answer, as a
peer's does), then datagrams from here to the relay's public address and
that port, which must reach the page. After a deploy, it shows whether Fly
takes UDP in on each port (fly.toml, NETWORK.md "Native games").

	node port/web/relay/test/probe_ports.mjs [site] [sessions]

site: https://openhaloce.com by default; sessions: 32 (the Worker gives an
address 10 tokens a minute, so they are spaced out).
*/

import dgram from "node:dgram";
import { lookup } from "node:dns/promises";
import { WebSocket } from "ws";

const site = process.argv[2] || "https://openhaloce.com";
const sessions = Number(process.argv[3] || 32);
const STUN_HOST = "stun.l.google.com";
const STUN_PORT = 19302;

const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value >>> 0); return bytes; };
const u16 = (value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
const tunnelPacket = () => { const packet = Buffer.alloc(48); packet[0] = 0x69; return packet; };
const stunRequest = () => {
	const request = Buffer.alloc(20);
	request.writeUInt16BE(0x0001, 0);
	request.writeUInt32BE(0x2112a442, 4);
	return request;
};
/* a STUN answer's XOR-MAPPED-ADDRESS: [address as a number, port] */
function mapped(answer) {
	for (let offset = 20; offset + 4 <= answer.length;) {
		const type = answer.readUInt16BE(offset);
		const length = answer.readUInt16BE(offset + 2);
		if (type === 0x0020) {
			return [(answer.readUInt32BE(offset + 8) ^ 0x2112a442) >>> 0, answer.readUInt16BE(offset + 6) ^ 0x2112];
		}
		offset += 4 + ((length + 3) & ~3);
	}
	return [0, 0];
}
const text = (address) => [24, 16, 8, 0].map((shift) => (address >>> shift) & 255).join(".");

const local = dgram.createSocket("udp4");
await new Promise((resolve) => local.bind(0, resolve));
/* this machine's public address, which the relay is to let in */
const stunAddress = (await lookup(STUN_HOST, { family: 4 })).address;
const [ownAddress] = await new Promise((resolve) => {
	local.once("message", (answer) => resolve(mapped(answer)));
	local.send(stunRequest(), STUN_PORT, stunAddress);
});
console.log(`this machine is ${text(ownAddress)}`);

const failing = [];
for (let round = 0; round < sessions; round++) {
	const started = Date.now();
	const ticket = await (await fetch(`${site}/net/relay`, { method: "POST", headers: { Origin: site } })).json();
	const socket = new WebSocket(`${ticket.relay}?token=${ticket.token}`, { origin: site });
	const [where, result] = await new Promise((resolve) => {
		let relayAddress = 0;
		let relayPort = 0;
		const timer = setTimeout(() => resolve([relayPort ? `${text(relayAddress)}:${relayPort}` : "?", "nothing came in"]), 8000);
		socket.on("message", (data) => {
			const message = Buffer.from(data);
			if (message[0] === 0x7f) {
				socket.send(message);
			} else if (message[0] === 6) {
				socket.send(Buffer.concat([Buffer.from([1]), u32(256), u32(message.readUInt32BE(5)), u16(STUN_PORT), stunRequest()]));
			} else if (message[0] === 1 && !relayPort) {
				[relayAddress, relayPort] = mapped(message.subarray(11));
				socket.send(Buffer.concat([Buffer.from([1]), u32(256), u32(ownAddress), u16(9), tunnelPacket()]));
				setTimeout(() => {
					for (let index = 0; index < 5; index++) {
						local.send(tunnelPacket(), relayPort, text(relayAddress));
					}
				}, 300);
			} else if (message[0] === 1) {
				clearTimeout(timer);
				resolve([`${text(relayAddress)}:${relayPort}`, "ok"]);
			}
		});
		socket.on("open", () => socket.send(Buffer.concat([Buffer.from([5]), u32(1), Buffer.from(STUN_HOST)])));
		socket.on("unexpected-response", (request, response) => resolve(["-", `refused ${response.statusCode}`]));
	});
	console.log(`session ${round + 1}: ${where}: ${result}`);
	if (result !== "ok") {
		failing.push(where);
	}
	socket.close();
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, 6500 - (Date.now() - started))));
}
console.log(failing.length ? `failing: ${failing.join(", ")}` : `all ${sessions} sessions took UDP in`);
local.close();
process.exit(failing.length ? 1 : 0);
