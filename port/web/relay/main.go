/*
The relay of native games (port/web/NETWORK.md, "Native games"): real
sockets for the browser build's game, which has none. A page (its
app/src/relay_bridge.js) connects over a WebSocket, and its game's sockets
to the internet (port/web/src/web_net.c, "The relay") become sockets
here: the desktop's internet play, running in the page, reaches MQTT
brokers, STUN servers and its peers' tunnels through them. Everything the
game sends its peers is sealed by the game; this sees sockets, addresses and
bytes only.

	go run .

Each WebSocket message is one record: a type byte, then its body, whose
numbers are big-endian. A handle is the game's, for one socket of a page.

	page to relay                           relay to page
	1 datagram  handle, address, port, data  1 datagram  handle, from address, from port, data
	2 connect   handle, address, port        2 connected handle
	3 data      handle, bytes                3 refused   handle
	4 close     handle                       4 data      handle, bytes
	5 resolve   number, name                 5 closed    handle
	                                         6 resolved  number, address (0: none)
	0x7f ping (echoed)                       0x7f ping   number

What it lets a page do is only what native games need, so that it serves
nothing else (NETWORK.md, "The relay's limits"):

  - a page connects with a token from the site's Worker (worker/relay.js):
    short-lived, used once, signed with the secret they share;
  - names: only the brokers' and the STUN servers' are looked up;
  - TCP: only to the brokers' addresses, on the brokers' port;
  - UDP: a STUN request to the STUN servers, and otherwise only the
    desktop's tunnel packets (their header and size), to public addresses;
    a destination that never answers gets a few hundred at most, and only
    the addresses a session sent to may send it anything (from any port, as
    TURN's permissions: a peer behind a NAT answers from its own);
  - and caps: each session's packets and bytes a second (each way), sockets and
    destinations, sessions from an address, and sessions in all.

Settings (the environment):

	PORT                  the WebSocket's (and /healthz's) port: 8790
	RELAY_TOKEN_SECRET    the secret the Worker signs tokens with (required,
	                      unless RELAY_INSECURE)
	RELAY_ORIGINS         the pages' origins allowed, comma-separated (any,
	                      if empty)
	RELAY_UDP_HOST        the address UDP sockets bind to: 0.0.0.0, or on
	                      Fly.io fly-global-services
	RELAY_UDP_PORTS       the UDP ports sessions take, as first-last (on
	                      Fly.io, the ports fly.toml routes); any, if empty
	RELAY_PUBLIC_IP       the address peers reach the UDP sockets at, which
	                      STUN's answers then tell the page (on Fly.io, the
	                      dedicated IPv4: STUN sees the machine's egress
	                      address, which takes nothing in)
	RELAY_BROKERS         the MQTT brokers, host:port, comma-separated (the
	                      desktop's network.signalling_brokers)
	RELAY_STUN            the STUN servers, host:port (network.stun_servers)
	RELAY_INSECURE=1      for tests on one machine: no tokens, and private
	                      addresses (a Docker network's) allowed
	RELAY_ALLOW_PRIVATE=1 private addresses allowed, tokens still needed (tests)
	RELAY_REPORT=1        logs each session's numbers every 5 seconds
	RELAY_SIGNALLING      where the browsers' signalling is, host:port
	                      (port/web/signalling, on this machine): /net/rooms/
	                      goes there, so that the two share an address
*/
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// ---------- settings

func setting(name, otherwise string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return otherwise
}

var (
	listenPort   = setting("PORT", "8790")
	secret       = setting("RELAY_TOKEN_SECRET", "")
	insecure     = setting("RELAY_INSECURE", "") == "1"
	allowPrivate = insecure || setting("RELAY_ALLOW_PRIVATE", "") == "1"
	origins      = splitList(setting("RELAY_ORIGINS", ""))
	udpHost      = setting("RELAY_UDP_HOST", "0.0.0.0")
	udpPorts     = setting("RELAY_UDP_PORTS", "")
	publicIP     = addressNumber(net.ParseIP(setting("RELAY_PUBLIC_IP", "")))
	report       = setting("RELAY_REPORT", "") == "1"
	signalling   = setting("RELAY_SIGNALLING", "")
	// (as port/linux/src/port_config.c's defaults)
	brokers     = endpoints(setting("RELAY_BROKERS", "broker.emqx.io:1883,broker.hivemq.com:1883,test.mosquitto.org:1883"))
	stunServers = endpoints(setting("RELAY_STUN", "stun.l.google.com:19302,stun.cloudflare.com:3478"))
)

const (
	maximumSessions           = 400
	maximumSessionsPerAddress = 4
	// a page's sockets here: its tunnel's (and a spare), its brokers'
	maximumUDPSockets = 2
	maximumTCPSockets = 6
	// the addresses a session's UDP goes to: the STUN servers, and the
	// host's candidates (a few, and the ports its NAT answers from)
	maximumDestinations = 16
	// the datagrams a destination gets before it answers (a tunnel tries
	// each of a peer's addresses 5 times a second for 30 seconds)
	maximumUnanswered = 200
	// each session's UDP to its peers: a page joins a game (it hosts for
	// browsers only), and sends the host about 35 datagrams (5 KiB) a second
	packetsPerSecond = 200
	bytesPerSecond   = 256 << 10
	// and from them: the host sends a joiner about 40 (15 KiB) a second
	packetsInPerSecond = 500
	bytesInPerSecond   = 512 << 10
	// to the brokers: a few small messages a second
	tcpBytesPerSecond = 64 << 10
	// a page looks up the brokers and STUN servers as it starts, and again
	// when it reconnects to them
	lookupsPerMinute = 30
	lookupsAtOnce    = 10

	// a token is used at most once in its life
	tokenLife = 60
	// the page's records (web_net.c's hold 64 KiB)
	maximumMessage = 0x10000
	// a stream's bytes in one message
	chunkSize      = 16 * 1024
	pingInterval   = time.Second
	reportInterval = 5 * time.Second
	connectTimeout = 10 * time.Second
	// messages waiting for a page's WebSocket: past this, datagrams to it
	// are dropped
	maximumQueued = 1024

	// the desktop's tunnel packets (port/linux/src/p2p.c): magic, the
	// sender's identifier, its packet number (little-endian), the sealed rest
	// with its tag; at most the game's largest datagram, inside
	tunnelMagic      = 0x69
	tunnelHeaderSize = 1 + 6 + 8
	tunnelTagSize    = 16
	tunnelSmallest   = tunnelHeaderSize + 1 + tunnelTagSize
	tunnelLargest    = tunnelHeaderSize + 1400 + tunnelTagSize
	// a STUN binding request (RFC 5389): its type and magic cookie
	stunBindingRequest = 0x0001
	stunBindingSuccess = 0x0101
	stunMagicCookie    = 0x2112a442
	stunMappedAddress  = 0x0001
	stunXorMapped      = 0x0020
)

// the records
const (
	inDatagram = 1
	inConnect  = 2
	inData     = 3
	inClose    = 4
	inResolve  = 5

	outDatagram  = 1
	outConnected = 2
	outRefused   = 3
	outData      = 4
	outClosed    = 5
	outResolved  = 6

	ping = 0x7f
)

type endpoint struct {
	host string
	port int
}

func splitList(text string) []string {
	var list []string
	for _, entry := range strings.Split(text, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			list = append(list, entry)
		}
	}
	return list
}

func endpoints(text string) []endpoint {
	var list []endpoint
	for _, entry := range splitList(text) {
		host, port, err := net.SplitHostPort(entry)
		number, _ := strconv.Atoi(port)
		if err == nil && number > 0 {
			list = append(list, endpoint{strings.ToLower(host), number})
		}
	}
	return list
}

// ---------- addresses

func addressText(address uint32) string {
	return fmt.Sprintf("%d.%d.%d.%d", address>>24, address>>16&255, address>>8&255, address&255)
}

func addressNumber(ip net.IP) uint32 {
	if four := ip.To4(); four != nil {
		return binary.BigEndian.Uint32(four)
	}
	return 0
}

func destinationKey(address uint32, port int) string {
	return addressText(address) + ":" + strconv.Itoa(port)
}

// addresses that are not on the internet: this machine's, private
// networks', shared, link-local (and cloud metadata), documentation's,
// benchmarking's, multicast and reserved
var notPublic = func() []*net.IPNet {
	var networks []*net.IPNet
	for _, text := range []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
		"192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
		"203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	} {
		_, network, _ := net.ParseCIDR(text)
		networks = append(networks, network)
	}
	return networks
}()

func isPublic(address uint32) bool {
	if allowPrivate {
		return true
	}
	ip := make(net.IP, 4)
	binary.BigEndian.PutUint32(ip, address)
	for _, network := range notPublic {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

// ---------- records

func record(kind byte, parts ...[]byte) []byte {
	size := 1
	for _, part := range parts {
		size += len(part)
	}
	bytes := make([]byte, 0, size)
	bytes = append(bytes, kind)
	for _, part := range parts {
		bytes = append(bytes, part...)
	}
	return bytes
}

func u32(value uint32) []byte {
	return binary.BigEndian.AppendUint32(nil, value)
}

func u16(value uint16) []byte {
	return binary.BigEndian.AppendUint16(nil, value)
}

// a budget that refills at rate a second, up to burst
type bucket struct {
	rate  float64
	burst float64
	level float64
	time  time.Time
}

func newBucket(rate, burst float64) *bucket {
	return &bucket{rate: rate, burst: burst, level: burst, time: time.Now()}
}

func (b *bucket) take(amount float64) bool {
	now := time.Now()
	b.level = min(b.burst, b.level+now.Sub(b.time).Seconds()*b.rate)
	b.time = now
	if b.level < amount {
		return false
	}
	b.level -= amount
	return true
}

// ---------- tokens (worker/relay.js makes them)

var (
	tokenPattern = regexp.MustCompile(`^(\d{1,12})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$`)
	tokensLock   sync.Mutex
	// tokens used, until they expire
	usedTokens = map[string]int64{}
)

// "<expiry>.<nonce>.<signature>": the expiry in seconds since 1970, a
// random nonce, and the HMAC-SHA256 (base64url) of "relay1.<expiry>.<nonce>"
// with the shared secret
func checkToken(token string) bool {
	if insecure {
		return true
	}
	match := tokenPattern.FindStringSubmatch(token)
	if match == nil {
		return false
	}
	expiry, nonce, signature := match[1], match[2], match[3]
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("relay1." + expiry + "." + nonce))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(signature), []byte(expected)) {
		return false
	}
	seconds, _ := strconv.ParseInt(expiry, 10, 64)
	now := time.Now().Unix()
	if seconds < now || seconds > now+tokenLife*2 {
		return false
	}
	tokensLock.Lock()
	defer tokensLock.Unlock()
	if _, used := usedTokens[nonce]; used {
		return false
	}
	usedTokens[nonce] = seconds
	return true
}

func forgetExpiredTokens() {
	for range time.Tick(10 * time.Second) {
		now := time.Now().Unix()
		tokensLock.Lock()
		for nonce, expiry := range usedTokens {
			if expiry < now {
				delete(usedTokens, nonce)
			}
		}
		tokensLock.Unlock()
	}
}

// ---------- the names a page may look up, and what their addresses take

type nameUse struct {
	kind string
	port int
}

var (
	names = func() map[string]nameUse {
		known := map[string]nameUse{}
		for _, broker := range brokers {
			known[broker.host] = nameUse{"broker", broker.port}
		}
		for _, server := range stunServers {
			known[server.host] = nameUse{"stun", server.port}
		}
		return known
	}()
	knownLock sync.Mutex
	// the addresses those names had: "<address>:<port>" -> "broker" or
	// "stun"
	known = map[string]string{}
)

func knownKind(key string) string {
	knownLock.Lock()
	defer knownLock.Unlock()
	return known[key]
}

// ---------- UDP ports (on Fly.io, the ones fly.toml routes)

var (
	portsLock sync.Mutex
	freePorts []int
	usePorts  bool
)

func setUpPorts() error {
	if udpPorts == "" {
		return nil
	}
	match := regexp.MustCompile(`^(\d+)-(\d+)$`).FindStringSubmatch(udpPorts)
	if match == nil {
		return fmt.Errorf("RELAY_UDP_PORTS %q is not first-last", udpPorts)
	}
	first, _ := strconv.Atoi(match[1])
	last, _ := strconv.Atoi(match[2])
	for port := first; port <= last; port++ {
		freePorts = append(freePorts, port)
	}
	usePorts = true
	return nil
}

func takePort() (int, bool) {
	portsLock.Lock()
	defer portsLock.Unlock()
	if !usePorts {
		return 0, true
	}
	if len(freePorts) == 0 {
		return 0, false
	}
	port := freePorts[0]
	freePorts = freePorts[1:]
	return port, true
}

func givePort(port int) {
	if !usePorts || port == 0 {
		return
	}
	portsLock.Lock()
	freePorts = append(freePorts, port)
	portsLock.Unlock()
}

func portsLeft() bool {
	portsLock.Lock()
	defer portsLock.Unlock()
	return !usePorts || len(freePorts) > 0
}

// ---------- sessions

var (
	sessionsLock      sync.Mutex
	sessionCount      int
	sessionsByAddress = map[string]int{}
	nextSession       int
)

type udpSocket struct {
	conn *net.UDPConn
	port int
}

type tunnelCount struct {
	first, highest, received uint64
}

type counts struct {
	datagramsOut, bytesOut, datagramsIn, bytesIn, droppedToPage int
	refused                                                     map[string]int
}

// one page: its sockets here, and its numbers
type session struct {
	id     int
	from   string
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	queue  chan []byte

	lock       sync.Mutex
	udpSockets map[uint32]*udpSocket
	tcpSockets map[uint32]net.Conn
	// where its UDP went: "<address>:<port>" -> datagrams not answered
	destinations map[string]int
	// the addresses its UDP went to, which may send it datagrams
	permitted  map[uint32]bool
	packets    *bucket
	packetsIn  *bucket
	bytesIn    *bucket
	bytes      *bucket
	tcpBytes   *bucket
	lookups    *bucket
	pings      map[uint32]time.Time
	nextPing   uint32
	roundTrips []time.Duration
	counts     counts
	tunnels    map[string]*tunnelCount
}

func newSession(conn *websocket.Conn, from string) *session {
	ctx, cancel := context.WithCancel(context.Background())
	sessionsLock.Lock()
	nextSession++
	id := nextSession
	sessionsLock.Unlock()
	return &session{
		id: id, from: from, conn: conn, ctx: ctx, cancel: cancel,
		queue:        make(chan []byte, maximumQueued),
		udpSockets:   map[uint32]*udpSocket{},
		tcpSockets:   map[uint32]net.Conn{},
		destinations: map[string]int{},
		permitted:    map[uint32]bool{},
		packets:      newBucket(packetsPerSecond, packetsPerSecond),
		bytes:        newBucket(bytesPerSecond, bytesPerSecond),
		packetsIn:    newBucket(packetsInPerSecond, packetsInPerSecond),
		bytesIn:      newBucket(bytesInPerSecond, bytesInPerSecond),
		tcpBytes:     newBucket(tcpBytesPerSecond, tcpBytesPerSecond),
		lookups:      newBucket(lookupsPerMinute/60.0, lookupsAtOnce),
		pings:        map[uint32]time.Time{},
		counts:       counts{refused: map[string]int{}},
		tunnels:      map[string]*tunnelCount{},
	}
}

func (s *session) log(format string, arguments ...any) {
	log.Printf("page %d: %s", s.id, fmt.Sprintf(format, arguments...))
}

// a request refused (counted, and logged at the next report). Under lock
func (s *session) refuse(why string) {
	s.counts.refused[why]++
}

// a message to the page; a droppable one is lost when the page is behind
func (s *session) send(message []byte, droppable bool) {
	if droppable {
		select {
		case s.queue <- message:
		case <-s.ctx.Done():
		default:
			s.lock.Lock()
			s.counts.droppedToPage++
			s.lock.Unlock()
		}
		return
	}
	select {
	case s.queue <- message:
	case <-s.ctx.Done():
	}
}

func (s *session) writer() {
	for {
		select {
		case message := <-s.queue:
			if s.conn.Write(s.ctx, websocket.MessageBinary, message) != nil {
				s.cancel()
				return
			}
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *session) run() {
	s.log("connected from %s", s.from)
	s.conn.SetReadLimit(maximumMessage + 1)
	go s.writer()
	go s.timers()
	for {
		kind, data, err := s.conn.Read(s.ctx)
		if err != nil {
			break
		}
		if kind == websocket.MessageBinary {
			s.receive(data)
		}
	}
	s.close()
}

func (s *session) timers() {
	pinger := time.NewTicker(pingInterval)
	reporter := time.NewTicker(reportInterval)
	defer pinger.Stop()
	defer reporter.Stop()
	for {
		select {
		case <-pinger.C:
			s.lock.Lock()
			s.nextPing++
			number := s.nextPing
			s.pings[number] = time.Now()
			delete(s.pings, number-30)
			s.lock.Unlock()
			s.send(record(ping, u32(number)), true)
		case <-reporter.C:
			s.report()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *session) receive(data []byte) {
	if len(data) < 5 || len(data) > maximumMessage {
		return
	}
	body := data[1:]
	handle := binary.BigEndian.Uint32(body)
	switch data[0] {
	case ping:
		s.lock.Lock()
		if sent, ok := s.pings[handle]; ok {
			delete(s.pings, handle)
			s.roundTrips = append(s.roundTrips, time.Since(sent))
		}
		s.lock.Unlock()
	case inDatagram:
		if len(body) >= 10 {
			s.datagram(handle, binary.BigEndian.Uint32(body[4:]), int(binary.BigEndian.Uint16(body[8:])), body[10:])
		}
	case inConnect:
		if len(body) >= 10 {
			s.connect(handle, binary.BigEndian.Uint32(body[4:]), int(binary.BigEndian.Uint16(body[8:])))
		}
	case inData:
		s.tcpData(handle, body[4:])
	case inClose:
		s.lock.Lock()
		s.closeSocket(handle)
		s.lock.Unlock()
	case inResolve:
		go s.resolve(handle, string(body[4:]))
	}
}

// ---- UDP

// the handle's UDP socket, made at its first datagram (nil: no more).
// Under lock
func (s *session) udp(handle uint32) *udpSocket {
	if socket := s.udpSockets[handle]; socket != nil {
		return socket
	}
	if len(s.udpSockets) >= maximumUDPSockets {
		s.refuse("UDP sockets")
		return nil
	}
	port, ok := takePort()
	if !ok {
		s.refuse("no UDP port free")
		return nil
	}
	address, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(udpHost, strconv.Itoa(port)))
	if err != nil {
		givePort(port)
		s.log("UDP %d: %v", handle, err)
		return nil
	}
	conn, err := net.ListenUDP("udp4", address)
	if err != nil {
		givePort(port)
		s.log("UDP %d: %v", handle, err)
		return nil
	}
	socket := &udpSocket{conn: conn, port: port}
	s.udpSockets[handle] = socket
	s.log("UDP socket %d is port %d here", handle, conn.LocalAddr().(*net.UDPAddr).Port)
	go s.udpReader(handle, conn)
	return socket
}

// what the page may send: a STUN request to a STUN server, or a tunnel
// packet to a public address (one that has answered, or has not been sent
// too many unanswered); "" if it may. Under lock
func (s *session) refusal(address uint32, port int, data []byte) string {
	key := destinationKey(address, port)
	if port == 0 || !isPublic(address) {
		return "address"
	}
	if knownKind(key) == "stun" {
		if len(data) >= 20 && binary.BigEndian.Uint16(data) == stunBindingRequest &&
			binary.BigEndian.Uint32(data[4:]) == stunMagicCookie {
			return ""
		}
		return "not STUN"
	}
	if len(data) < tunnelSmallest || len(data) > tunnelLargest || data[0] != tunnelMagic {
		return "not a tunnel packet"
	}
	unanswered, sent := s.destinations[key]
	if !sent && len(s.destinations) >= maximumDestinations {
		return "destinations"
	}
	if unanswered >= maximumUnanswered {
		return "unanswered"
	}
	return ""
}

func (s *session) datagram(handle, address uint32, port int, data []byte) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if why := s.refusal(address, port, data); why != "" {
		s.refuse(why)
		return
	}
	if !s.packets.take(1) || !s.bytes.take(float64(len(data))) {
		s.refuse("rate")
		return
	}
	socket := s.udp(handle)
	if socket == nil {
		return
	}
	s.destinations[destinationKey(address, port)]++
	s.permitted[address] = true
	s.counts.datagramsOut++
	s.counts.bytesOut += len(data)
	ip := make(net.IP, 4)
	binary.BigEndian.PutUint32(ip, address)
	socket.conn.WriteToUDP(data, &net.UDPAddr{IP: ip, Port: port})
}

// datagrams to one of the page's sockets: only from the addresses the session
// sent to, from any of their ports (a peer behind a NAT that gives each
// destination its own port answers from another than STUN told)
func (s *session) udpReader(handle uint32, conn *net.UDPConn) {
	buffer := make([]byte, 65536)
	for {
		size, from, err := conn.ReadFromUDP(buffer)
		if err != nil {
			return
		}
		address := addressNumber(from.IP)
		key := destinationKey(address, from.Port)
		data := buffer[:size]
		s.lock.Lock()
		if !s.permitted[address] {
			s.refuse("from a stranger")
			s.lock.Unlock()
			continue
		}
		// (it answers: each of its ports may be sent more, this one too)
		prefix := addressText(address) + ":"
		for other := range s.destinations {
			if strings.HasPrefix(other, prefix) {
				s.destinations[other] = 0
			}
		}
		if len(s.destinations) < maximumDestinations {
			s.destinations[key] = 0
		}
		// (more than a host sends a joiner: the relay's bandwidth is not to
		// be had through a peer)
		if !s.packetsIn.take(1) || !s.bytesIn.take(float64(size)) {
			s.refuse("rate in")
			s.lock.Unlock()
			continue
		}
		s.counts.datagramsIn++
		s.counts.bytesIn += size
		s.watchTunnel(data, key)
		if publicIP != 0 && knownKind(key) == "stun" {
			tellPublicAddress(data, conn.LocalAddr().(*net.UDPAddr).Port)
		}
		s.lock.Unlock()
		s.send(record(outDatagram, u32(handle), u32(address), u16(uint16(from.Port)), data), true)
	}
}

// a STUN server's answer, with the address it saw replaced by the one
// peers reach this socket at (RELAY_PUBLIC_IP, and the socket's port): on
// Fly.io, what leaves a machine goes out from its egress address, but only
// the dedicated IP takes anything in (and its answers then go out from it)
func tellPublicAddress(data []byte, port int) {
	if len(data) < 20 || binary.BigEndian.Uint16(data) != stunBindingSuccess ||
		binary.BigEndian.Uint32(data[4:]) != stunMagicCookie {
		return
	}
	for offset := 20; offset+4 <= len(data); {
		kind := binary.BigEndian.Uint16(data[offset:])
		length := int(binary.BigEndian.Uint16(data[offset+2:]))
		value := data[offset+4:]
		if len(value) < length {
			return
		}
		// (IPv4: family 1)
		if (kind == stunMappedAddress || kind == stunXorMapped) && length >= 8 && value[1] == 0x01 {
			mappedPort, address := uint16(port), publicIP
			if kind == stunXorMapped {
				mappedPort ^= stunMagicCookie >> 16
				address ^= stunMagicCookie
			}
			binary.BigEndian.PutUint16(value[2:], mappedPort)
			binary.BigEndian.PutUint32(value[4:], address)
		}
		offset += 4 + (length+3)&^3
	}
}

// ---- TCP (to the brokers)

func (s *session) connect(handle, address uint32, port int) {
	s.lock.Lock()
	if knownKind(destinationKey(address, port)) != "broker" {
		s.refuse("TCP to a non-broker")
		s.lock.Unlock()
		s.send(record(outRefused, u32(handle)), false)
		return
	}
	if _, open := s.tcpSockets[handle]; open || len(s.tcpSockets) >= maximumTCPSockets {
		s.refuse("TCP sockets")
		s.lock.Unlock()
		s.send(record(outRefused, u32(handle)), false)
		return
	}
	// (taken while it connects: a stand-in, replaced by the connection)
	s.tcpSockets[handle] = nil
	s.lock.Unlock()
	s.log("TCP %d to %s:%d", handle, addressText(address), port)
	go func() {
		conn, err := net.DialTimeout("tcp4", destinationKey(address, port), connectTimeout)
		s.lock.Lock()
		current, open := s.tcpSockets[handle]
		if err != nil || !open || current != nil || s.ctx.Err() != nil {
			if open && current == nil {
				delete(s.tcpSockets, handle)
			}
			s.lock.Unlock()
			if conn != nil {
				conn.Close()
			}
			if err != nil {
				s.log("TCP %d: %v", handle, err)
			}
			if open {
				s.send(record(outRefused, u32(handle)), false)
			}
			return
		}
		if tcp, ok := conn.(*net.TCPConn); ok {
			tcp.SetNoDelay(true)
		}
		s.tcpSockets[handle] = conn
		s.lock.Unlock()
		s.send(record(outConnected, u32(handle)), false)
		buffer := make([]byte, chunkSize)
		for {
			size, err := conn.Read(buffer)
			if size > 0 {
				s.send(record(outData, u32(handle), buffer[:size]), false)
			}
			if err != nil {
				break
			}
		}
		s.lock.Lock()
		stillOurs := s.tcpSockets[handle] == conn
		if stillOurs {
			delete(s.tcpSockets, handle)
		}
		s.lock.Unlock()
		conn.Close()
		if stillOurs {
			s.send(record(outClosed, u32(handle)), false)
		}
	}()
}

func (s *session) tcpData(handle uint32, data []byte) {
	s.lock.Lock()
	conn := s.tcpSockets[handle]
	if conn == nil {
		s.lock.Unlock()
		return
	}
	if !s.tcpBytes.take(float64(len(data))) {
		// (a stream cannot lose bytes: it ends)
		s.refuse("TCP rate")
		s.closeSocket(handle)
		s.lock.Unlock()
		s.send(record(outClosed, u32(handle)), false)
		return
	}
	s.lock.Unlock()
	conn.Write(data)
}

// Under lock
func (s *session) closeSocket(handle uint32) {
	if conn, open := s.tcpSockets[handle]; open {
		delete(s.tcpSockets, handle)
		if conn != nil {
			conn.Close()
		}
	}
	if socket := s.udpSockets[handle]; socket != nil {
		delete(s.udpSockets, handle)
		socket.conn.Close()
		givePort(socket.port)
	}
}

// ---- names

func (s *session) resolve(number uint32, name string) {
	var address uint32
	use, allowed := names[strings.ToLower(name)]
	s.lock.Lock()
	switch {
	case !allowed:
		s.refuse("name")
	case !s.lookups.take(1):
		s.refuse("lookups")
	default:
		s.lock.Unlock()
		ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", name)
		cancel()
		if err == nil && len(ips) > 0 {
			address = addressNumber(ips[0])
			knownLock.Lock()
			known[destinationKey(address, use.port)] = use.kind
			knownLock.Unlock()
		} else {
			s.log("no address for %s: %v", name, err)
		}
		s.lock.Lock()
	}
	s.lock.Unlock()
	s.send(record(outResolved, u32(number), u32(address)), false)
}

// ---- numbers

// the loss of a peer's tunnel packets on their way here, by their
// numbers. Under lock
func (s *session) watchTunnel(data []byte, from string) {
	if len(data) < tunnelSmallest || data[0] != tunnelMagic {
		return
	}
	sender := hex.EncodeToString(data[1:7]) + " (" + from + ")"
	number := binary.LittleEndian.Uint64(data[7:])
	tunnel := s.tunnels[sender]
	if tunnel == nil {
		tunnel = &tunnelCount{first: number, highest: number}
		s.tunnels[sender] = tunnel
	}
	tunnel.received++
	tunnel.highest = max(tunnel.highest, number)
}

func (s *session) report() {
	s.lock.Lock()
	trips := s.roundTrips
	s.roundTrips = nil
	c := s.counts
	s.counts = counts{refused: map[string]int{}}
	var parts []string
	if len(c.refused) > 0 {
		var refused []string
		for why, count := range c.refused {
			refused = append(refused, fmt.Sprintf("%d %s", count, why))
		}
		sort.Strings(refused)
		parts = append(parts, "refused "+strings.Join(refused, ", "))
	}
	if c.droppedToPage > 0 {
		parts = append(parts, fmt.Sprintf("%d dropped to the page", c.droppedToPage))
	}
	if report {
		if len(trips) > 0 {
			sort.Slice(trips, func(a, b int) bool { return trips[a] < trips[b] })
			var sum time.Duration
			for _, trip := range trips {
				sum += trip
			}
			ms := func(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }
			parts = append(parts, fmt.Sprintf("page round trip %.1f ms (min %.1f, max %.1f)",
				ms(sum/time.Duration(len(trips))), ms(trips[0]), ms(trips[len(trips)-1])))
		}
		seconds := reportInterval.Seconds()
		parts = append(parts, fmt.Sprintf("to peers %.0f/s %.1f KiB/s", float64(c.datagramsOut)/seconds,
			float64(c.bytesOut)/seconds/1024))
		parts = append(parts, fmt.Sprintf("from peers %.0f/s %.1f KiB/s", float64(c.datagramsIn)/seconds,
			float64(c.bytesIn)/seconds/1024))
		for sender, tunnel := range s.tunnels {
			if tunnel.highest >= tunnel.first {
				expected := tunnel.highest - tunnel.first + 1
				lost := uint64(0)
				if expected > tunnel.received {
					lost = expected - tunnel.received
				}
				parts = append(parts, fmt.Sprintf("tunnel from %s: %d packets, %d missing (%.1f%%)",
					sender, tunnel.received, lost, float64(lost)/float64(expected)*100))
			}
			s.tunnels[sender] = &tunnelCount{first: tunnel.highest + 1, highest: tunnel.highest}
		}
	}
	s.lock.Unlock()
	if len(parts) > 0 {
		s.log("%s", strings.Join(parts, "; "))
	}
}

func (s *session) close() {
	s.cancel()
	s.report()
	s.lock.Lock()
	for handle := range s.tcpSockets {
		s.closeSocket(handle)
	}
	for handle := range s.udpSockets {
		s.closeSocket(handle)
	}
	s.lock.Unlock()
	s.conn.CloseNow()
	sessionsLock.Lock()
	sessionCount--
	if sessionsByAddress[s.from]--; sessionsByAddress[s.from] <= 0 {
		delete(sessionsByAddress, s.from)
	}
	sessionsLock.Unlock()
	s.log("disconnected")
}

// ---------- the server

// (on Fly.io, the page's address is in Fly-Client-IP)
func clientAddress(request *http.Request) string {
	if address := request.Header.Get("Fly-Client-IP"); address != "" {
		return address
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return request.RemoteAddr
	}
	return strings.TrimPrefix(host, "::ffff:")
}

func originAllowed(origin string) bool {
	if len(origins) == 0 {
		return true
	}
	for _, allowed := range origins {
		if origin == allowed {
			return true
		}
	}
	return false
}

func serveRelay(response http.ResponseWriter, request *http.Request) {
	from := clientAddress(request)
	origin := request.Header.Get("Origin")
	status := 0
	switch {
	case !originAllowed(origin):
		status = http.StatusForbidden
	case !checkToken(request.URL.Query().Get("token")):
		status = http.StatusUnauthorized
	}
	if status == 0 {
		sessionsLock.Lock()
		switch {
		case sessionCount >= maximumSessions || !portsLeft():
			status = http.StatusServiceUnavailable
		case sessionsByAddress[from] >= maximumSessionsPerAddress:
			status = http.StatusTooManyRequests
		default:
			sessionCount++
			sessionsByAddress[from]++
		}
		sessionsLock.Unlock()
	}
	if status != 0 {
		log.Printf("refused %s (%s): %d %s", from, origin, status, http.StatusText(status))
		http.Error(response, http.StatusText(status), status)
		return
	}
	// (the origin is checked above, against RELAY_ORIGINS)
	conn, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		sessionsLock.Lock()
		sessionCount--
		if sessionsByAddress[from]--; sessionsByAddress[from] <= 0 {
			delete(sessionsByAddress, from)
		}
		sessionsLock.Unlock()
		return
	}
	newSession(conn, from).run()
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds | log.LUTC)
	if secret == "" && !insecure {
		log.Fatal("relay: RELAY_TOKEN_SECRET is not set (RELAY_INSECURE=1 for a test on one machine)")
	}
	if err := setUpPorts(); err != nil {
		log.Fatal("relay: ", err)
	}
	go forgetExpiredTokens()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(response http.ResponseWriter, request *http.Request) {
		sessionsLock.Lock()
		count := sessionCount
		sessionsLock.Unlock()
		fmt.Fprintf(response, "ok %d\n", count)
	})
	mux.HandleFunc("GET /{$}", serveRelay)
	if signalling != "" {
		// the rooms' WebSockets, as they are: a few messages for each join,
		// and none of a game's traffic
		mux.Handle("/net/rooms/", httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: signalling}))
	}

	note := ""
	if insecure {
		note = " (RELAY_INSECURE: no tokens, private addresses allowed: keep it private)"
	}
	ports := "any"
	if udpPorts != "" {
		ports = udpPorts
	}
	log.Printf("relay: listening on port %s%s; UDP %s on %s", listenPort, note, ports, udpHost)
	server := &http.Server{Addr: ":" + listenPort, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("relay: ", err)
	}
}
