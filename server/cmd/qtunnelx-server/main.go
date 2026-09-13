package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	magic     = "QTX1"
	version   = byte(1)
	tunSetIFF = 0x400454ca
	iffTun    = 0x0001
	iffNoPI   = 0x1000
	typeData  = byte(0)
	typePing  = byte(1)
	typePong  = byte(2)
)

type User struct {
	Username     string  `json:"username"`
	Password     string  `json:"password"`
	IP           string  `json:"ip"`
	UploadMbps   float64 `json:"upload_mbps,omitempty"`
	DownloadMbps float64 `json:"download_mbps,omitempty"`
}

type Config struct {
	Users []User `json:"users"`
}

type peer struct {
	user        User
	key         []byte
	addr        *net.UDPAddr
	uplimiter   *rateLimiter
	downlimiter *rateLimiter
}

type rateLimiter struct {
	mu      sync.Mutex
	rateBps float64
	burst   float64
	tokens  float64
	last    time.Time
}

func newRateLimiter(mbps float64) *rateLimiter {
	if mbps <= 0 {
		return nil
	}
	rate := mbps * 1000 * 1000 / 8
	burst := rate * 0.25
	if burst < 64*1024 {
		burst = 64 * 1024
	}
	return &rateLimiter{rateBps: rate, burst: burst, tokens: burst, last: time.Now()}
}

func (r *rateLimiter) allow(n int) bool {
	if r == nil {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.tokens += now.Sub(r.last).Seconds() * r.rateBps
	if r.tokens > r.burst {
		r.tokens = r.burst
	}
	r.last = now
	need := float64(n)
	if r.tokens < need {
		return false
	}
	r.tokens -= need
	return true
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		must(serveCmd(os.Args[2:]))
	case "user-add":
		must(userAddCmd(os.Args[2:]))
	case "user-list":
		must(userListCmd(os.Args[2:]))
	case "user-del":
		must(userDelCmd(os.Args[2:]))
	case "user-speed":
		must(userSpeedCmd(os.Args[2:]))
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Println("QTunnel X server")
	fmt.Println("  serve     -config /etc/qtunnelx/users.json -listen :46000 -tun qtx0")
	fmt.Println("  user-add   -config /etc/qtunnelx/users.json -username alice -password secret [-ip 10.44.0.2] [-upload-mbps 20] [-download-mbps 50]")
	fmt.Println("  user-list  -config /etc/qtunnelx/users.json")
	fmt.Println("  user-speed -config /etc/qtunnelx/users.json -username alice -upload-mbps 20 -download-mbps 50")
	fmt.Println("  user-del   -config /etc/qtunnelx/users.json -username alice")
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func loadConfig(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return c, nil
	}
	err = json.Unmarshal(b, &c)
	return c, err
}

func saveConfig(path string, c Config) error {
	if err := os.MkdirAll(dirOf(path), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0600)
}

func dirOf(p string) string {
	i := strings.LastIndex(p, "/")
	if i <= 0 {
		return "."
	}
	return p[:i]
}

func userAddCmd(args []string) error {
	fs := flag.NewFlagSet("user-add", flag.ContinueOnError)
	config := fs.String("config", "/etc/qtunnelx/users.json", "config path")
	username := fs.String("username", "", "username")
	password := fs.String("password", "", "password")
	ip := fs.String("ip", "", "client tunnel IPv4")
	upload := fs.Float64("upload-mbps", 0, "upload limit Mbps, 0=unlimited")
	download := fs.Float64("download-mbps", 0, "download limit Mbps, 0=unlimited")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *username == "" || *password == "" {
		return errors.New("username and password are required")
	}
	c, err := loadConfig(*config)
	if err != nil {
		return err
	}
	for _, u := range c.Users {
		if u.Username == *username {
			return errors.New("user already exists")
		}
	}
	if *ip == "" {
		*ip = nextIP(c)
	}
	if net.ParseIP(*ip) == nil {
		return errors.New("invalid IP")
	}
	if *upload < 0 || *download < 0 {
		return errors.New("speed limits cannot be negative")
	}
	c.Users = append(c.Users, User{Username: *username, Password: *password, IP: *ip, UploadMbps: *upload, DownloadMbps: *download})
	sort.Slice(c.Users, func(i, j int) bool { return c.Users[i].IP < c.Users[j].IP })
	if err := saveConfig(*config, c); err != nil {
		return err
	}
	fmt.Printf("added %s -> %s upload=%s download=%s\n", *username, *ip, formatMbps(*upload), formatMbps(*download))
	return nil
}

func nextIP(c Config) string {
	used := map[string]bool{}
	for _, u := range c.Users {
		used[u.IP] = true
	}
	for i := 2; i < 255; i++ {
		s := fmt.Sprintf("10.44.0.%d", i)
		if !used[s] {
			return s
		}
	}
	return "10.44.0.254"
}

func userListCmd(args []string) error {
	fs := flag.NewFlagSet("user-list", flag.ContinueOnError)
	config := fs.String("config", "/etc/qtunnelx/users.json", "config path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	c, err := loadConfig(*config)
	if err != nil {
		return err
	}
	for _, u := range c.Users {
		fmt.Printf("%-20s %-15s up=%-10s down=%-10s\n", u.Username, u.IP, formatMbps(u.UploadMbps), formatMbps(u.DownloadMbps))
	}
	return nil
}

func formatMbps(v float64) string {
	if v <= 0 {
		return "unlimited"
	}
	return strconv.FormatFloat(v, 'f', -1, 64) + "Mbps"
}

func userSpeedCmd(args []string) error {
	fs := flag.NewFlagSet("user-speed", flag.ContinueOnError)
	config := fs.String("config", "/etc/qtunnelx/users.json", "config path")
	username := fs.String("username", "", "username")
	upload := fs.Float64("upload-mbps", 0, "upload limit Mbps, 0=unlimited")
	download := fs.Float64("download-mbps", 0, "download limit Mbps, 0=unlimited")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *username == "" {
		return errors.New("username is required")
	}
	if *upload < 0 || *download < 0 {
		return errors.New("speed limits cannot be negative")
	}
	c, err := loadConfig(*config)
	if err != nil {
		return err
	}
	found := false
	for i := range c.Users {
		if c.Users[i].Username == *username {
			c.Users[i].UploadMbps = *upload
			c.Users[i].DownloadMbps = *download
			found = true
			break
		}
	}
	if !found {
		return errors.New("user not found")
	}
	if err := saveConfig(*config, c); err != nil {
		return err
	}
	fmt.Printf("updated %s upload=%s download=%s\n", *username, formatMbps(*upload), formatMbps(*download))
	return nil
}

func userDelCmd(args []string) error {
	fs := flag.NewFlagSet("user-del", flag.ContinueOnError)
	config := fs.String("config", "/etc/qtunnelx/users.json", "config path")
	username := fs.String("username", "", "username")
	if err := fs.Parse(args); err != nil {
		return err
	}
	c, err := loadConfig(*config)
	if err != nil {
		return err
	}
	out := c.Users[:0]
	found := false
	for _, u := range c.Users {
		if u.Username == *username {
			found = true
			continue
		}
		out = append(out, u)
	}
	if !found {
		return errors.New("user not found")
	}
	c.Users = out
	return saveConfig(*config, c)
}

func serveCmd(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	configPath := fs.String("config", "/etc/qtunnelx/users.json", "config path")
	listen := fs.String("listen", ":46000", "UDP listen")
	tunName := fs.String("tun", "qtx0", "TUN interface name")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if len(cfg.Users) == 0 {
		return errors.New("no users configured")
	}

	tun, actualName, err := openTun(*tunName)
	if err != nil {
		return err
	}
	defer tun.Close()
	fmt.Println("TUN:", actualName)

	ua, err := net.ResolveUDPAddr("udp", *listen)
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp", ua)
	if err != nil {
		return err
	}
	defer conn.Close()
	fmt.Println("UDP listening on", conn.LocalAddr())

	peersByName := map[string]*peer{}
	peersByIP := map[string]*peer{}
	for _, u := range cfg.Users {
		p := &peer{user: u, key: deriveKey(u.Username, u.Password), uplimiter: newRateLimiter(u.UploadMbps), downlimiter: newRateLimiter(u.DownloadMbps)}
		peersByName[u.Username] = p
		peersByIP[u.IP] = p
	}
	var mu sync.RWMutex

	done := make(chan struct{})
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := conn.ReadFromUDP(buf)
			if err != nil {
				close(done)
				return
			}
			username, plain, err := decryptFrame(peersByName, buf[:n])
			if err != nil {
				continue
			}
			p := peersByName[username]
			mu.Lock()
			p.addr = addr
			mu.Unlock()
			if len(plain) < 1 {
				continue
			}
			switch plain[0] {
			case typeData:
				pkt := plain[1:]
				if !validIPv4Source(pkt, p.user.IP) {
					continue
				}
				if !p.uplimiter.allow(len(pkt)) {
					continue
				}
				_, _ = tun.Write(pkt)
			case typePing:
				if len(plain) == 9 {
					resp := append([]byte{typePong}, plain[1:]...)
					enc, _ := encryptFrame(p.user.Username, p.key, resp)
					_, _ = conn.WriteToUDP(enc, addr)
				}
			}
		}
	}()

	go func() {
		buf := make([]byte, 65535)
		for {
			n, err := tun.Read(buf)
			if err != nil {
				return
			}
			pkt := buf[:n]
			dst := ipv4Dst(pkt)
			if dst == "" {
				continue
			}
			p := peersByIP[dst]
			if p == nil {
				continue
			}
			mu.RLock()
			addr := p.addr
			mu.RUnlock()
			if addr == nil {
				continue
			}
			if !p.downlimiter.allow(n) {
				continue
			}
			plain := make([]byte, 1+n)
			plain[0] = typeData
			copy(plain[1:], pkt)
			enc, err := encryptFrame(p.user.Username, p.key, plain)
			if err != nil {
				continue
			}
			_, _ = conn.WriteToUDP(enc, addr)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
		return nil
	case <-done:
		return errors.New("UDP listener stopped")
	}
}

func deriveKey(username, password string) []byte {
	// PBKDF2-HMAC-SHA256, 100000 iterations, 32-byte key.
	// One block is enough because SHA-256 output is 32 bytes.
	salt := []byte("QTunnelX-v1:" + username)
	var block [4]byte
	binary.BigEndian.PutUint32(block[:], 1)
	mac := hmac.New(sha256.New, []byte(password))
	mac.Write(salt)
	mac.Write(block[:])
	u := mac.Sum(nil)
	t := append([]byte(nil), u...)
	for i := 1; i < 100000; i++ {
		mac = hmac.New(sha256.New, []byte(password))
		mac.Write(u)
		u = mac.Sum(nil)
		for j := range t {
			t[j] ^= u[j]
		}
	}
	return t
}

func encryptFrame(username string, key, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ub := []byte(username)
	if len(ub) > 255 {
		return nil, errors.New("username too long")
	}
	head := make([]byte, 0, 6+len(ub)+len(nonce))
	head = append(head, []byte(magic)...)
	head = append(head, version, byte(len(ub)))
	head = append(head, ub...)
	head = append(head, nonce...)
	aad := head[:6+len(ub)]
	ct := gcm.Seal(nil, nonce, plain, aad)
	return append(head, ct...), nil
}

func decryptFrame(peers map[string]*peer, b []byte) (string, []byte, error) {
	if len(b) < 6 || string(b[:4]) != magic || b[4] != version {
		return "", nil, errors.New("bad header")
	}
	ul := int(b[5])
	if len(b) < 6+ul+12+16 {
		return "", nil, errors.New("short frame")
	}
	user := string(b[6 : 6+ul])
	p := peers[user]
	if p == nil {
		return "", nil, errors.New("unknown user")
	}
	block, err := aes.NewCipher(p.key)
	if err != nil {
		return "", nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", nil, err
	}
	ns := gcm.NonceSize()
	off := 6 + ul
	if len(b) < off+ns+gcm.Overhead() {
		return "", nil, errors.New("short cipher")
	}
	nonce := b[off : off+ns]
	aad := b[:off]
	plain, err := gcm.Open(nil, nonce, b[off+ns:], aad)
	return user, plain, err
}

func validIPv4Source(pkt []byte, want string) bool {
	if len(pkt) < 20 || pkt[0]>>4 != 4 {
		return false
	}
	return net.IP(pkt[12:16]).String() == want
}
func ipv4Dst(pkt []byte) string {
	if len(pkt) < 20 || pkt[0]>>4 != 4 {
		return ""
	}
	return net.IP(pkt[16:20]).String()
}

func openTun(name string) (*os.File, string, error) {
	f, err := os.OpenFile("/dev/net/tun", os.O_RDWR, 0)
	if err != nil {
		return nil, "", err
	}
	var ifr [40]byte
	copy(ifr[:16], []byte(name))
	binary.LittleEndian.PutUint16(ifr[16:18], uint16(iffTun|iffNoPI))
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), uintptr(tunSetIFF), uintptr(unsafe.Pointer(&ifr[0])))
	if errno != 0 {
		f.Close()
		return nil, "", errno
	}
	actual := strings.TrimRight(string(ifr[:16]), "\x00")
	return f, actual, nil
}
