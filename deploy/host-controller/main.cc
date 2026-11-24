// Only the admission test supplies a compile-time synthetic registration.
#include <cstring>
#include <sysexits.h>

#if defined(__APPLE__) && (defined(__arm64__) || defined(__x86_64__)) && defined(PATRICK_SYNTHETIC_REGISTRATION)
#include <CommonCrypto/CommonDigest.h>
#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <dirent.h>
#include <fcntl.h>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace {
constexpr int control_fd = 3;

bool private_directory(const std::string& path, struct stat& metadata) {
  return lstat(path.c_str(), &metadata) == 0 && S_ISDIR(metadata.st_mode) &&
         metadata.st_uid == fixture_uid && (metadata.st_mode & 07777) == 0700;
}

bool matches_file(const std::string& path, mode_t permissions, const char* expected_sha) {
  int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return false;
  struct stat metadata {};
  bool ok = fstat(fd, &metadata) == 0 && S_ISREG(metadata.st_mode) &&
            metadata.st_uid == fixture_uid && (metadata.st_mode & 07777) == permissions;
  CC_SHA256_CTX hash;
  CC_SHA256_Init(&hash);
  unsigned char buffer[65536];
  while (ok) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      ok = false;
      break;
    }
    CC_SHA256_Update(&hash, buffer, static_cast<CC_LONG>(count));
  }
  if (close(fd) != 0 || !ok) return false;
  unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(bytes, &hash);
  char hex[sizeof(bytes) * 2 + 1];
  for (size_t i = 0; i < sizeof(bytes); ++i) {
    snprintf(hex + i * 2, 3, "%02x", static_cast<unsigned>(bytes[i]));
  }
  return strcmp(hex, expected_sha) == 0;
}

// Enumerate the open descriptors themselves. A soft limit need not cover every inherited fd.
bool confine_descriptors() {
  DIR* directory = opendir("/dev/fd");
  if (!directory) return false;
  bool ok = true;
  while (ok) {
    errno = 0;
    dirent* entry = readdir(directory);
    if (!entry) {
      ok = errno == 0;
      break;
    }
    if (entry->d_name[0] == '.') continue;
    char* end = nullptr;
    long number = strtol(entry->d_name, &end, 10);
    if (errno || *end || number < 0 || number > INT_MAX) {
      ok = false;
      break;
    }
    if (number > control_fd && number != dirfd(directory)) {
      ok = fcntl(static_cast<int>(number), F_SETFD, FD_CLOEXEC) == 0;
    }
  }
  return closedir(directory) == 0 && ok;
}

bool connect_control(const std::string& path) {
  sockaddr_un address {};
  if (path.size() >= sizeof(address.sun_path)) return false;
  struct stat endpoint {};
  if (lstat(path.c_str(), &endpoint) != 0 || !S_ISSOCK(endpoint.st_mode) ||
      endpoint.st_uid != fixture_uid) return false;
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, path.c_str(), path.size() + 1);
  address.sun_len = SUN_LEN(&address);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < control_fd || fcntl(fd, F_SETFL, O_NONBLOCK) != 0 ||
      connect(fd, reinterpret_cast<sockaddr*>(&address), address.sun_len) != 0) return false;
  uid_t peer_uid;
  gid_t peer_gid;
  if (getpeereid(fd, &peer_uid, &peer_gid) != 0 || peer_uid != fixture_uid) return false;
  if (fd != control_fd && (dup2(fd, control_fd) < 0 || close(fd) != 0)) return false;
  return fcntl(control_fd, F_SETFD, 0) == 0;
}

int launch() {
  std::string root = fixture_root;
  std::string node = root + "/node";
  std::string bootstrap = root + "/service-bootstrap.mts";
  std::string cwd = root + "/service";
  std::string home = cwd + "/home";
  char canonical[PATH_MAX];
  struct stat metadata {};
  if (getuid() != fixture_uid || geteuid() != fixture_uid ||
      !realpath(fixture_root, canonical) || root != canonical ||
      !private_directory(root, metadata) || static_cast<unsigned long long>(metadata.st_dev) != fixture_device ||
      metadata.st_ino != fixture_inode || !private_directory(cwd, metadata) ||
      !private_directory(home, metadata) || !matches_file(node, 0500, fixture_node_sha) ||
      !matches_file(bootstrap, 0400, bootstrap_sha)) return EX_CONFIG;
  // The fixture's only writer is its parent. Hash then exec by pathname under this
  // private root does not establish immutable, independently owned production materials.
  umask(0077);
  if (chdir(cwd.c_str()) != 0 || !connect_control(root + "/control.sock") ||
      !confine_descriptors()) return EX_UNAVAILABLE;
  char no_addons[] = "--no-addons";
  char* argv[] = {node.data(), no_addons, bootstrap.data(), nullptr};
  std::string home_var = "HOME=" + home;
  // Pin a neutral Darwin text encoding before CoreFoundation initializes the runtime.
  char encoding[64];
  snprintf(encoding, sizeof(encoding), "__CF_USER_TEXT_ENCODING=0x%X:0x0:0x0", fixture_uid);
  char* envp[] = {home_var.data(), encoding, nullptr};
  execve(node.c_str(), argv, envp);
  return EX_UNAVAILABLE;
}
}  // namespace
#endif

int main(int argc, char** argv) {
  if (argc != 3 || strcmp(argv[1], "run-role") || strcmp(argv[2], "service")) return EX_USAGE;
#if defined(__APPLE__) && (defined(__arm64__) || defined(__x86_64__)) && defined(PATRICK_SYNTHETIC_REGISTRATION)
  return launch();
#else
  return EX_CONFIG;
#endif
}
