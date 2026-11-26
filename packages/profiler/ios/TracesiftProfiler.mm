// Starts profiling without the app calling anything, and speaks the same newline-delimited JSON as
// the Android ProfilerLink.
#import <UIKit/UIKit.h>

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <poll.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <errno.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <sstream>
#include <string>

#include <hermes/hermes.h>

static NSString *const kEnabledKey = @"TracesiftProfilingEnabled";
static NSString *const kPortKey = @"TracesiftProfilerPort";
// "listen" makes the app serve on its own loopback instead of dialling out.
static NSString *const kTransportKey = @"TracesiftProfilerTransport";
static const int kDefaultPort = 8089;
static const NSTimeInterval kRetryDelay = 2.0;
// The CLI rejects any single line past 8 MB. A multiple of 4 keeps every
// base64 chunk a whole number of quanta.
static const NSUInteger kChunkChars = 256 * 1024;
static const double kDefaultHz = 1000;

/// Hermes' root API.
static facebook::hermes::IHermesRootAPI *HermesRoot(void) {
  auto *api = facebook::hermes::makeHermesRootAPI();
  if (api == nullptr) return nullptr;
  return facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(api);
}

@interface TracesiftProfilerLink : NSObject
+ (void)startWithPort:(int)port listen:(BOOL)listen;
@end

@implementation TracesiftProfilerLink

static BOOL sStarted = NO;
// Only touched from the link thread.
static BOOL sSampling = NO;

+ (void)startWithPort:(int)port listen:(BOOL)listen {
  @synchronized(self) {
    if (sStarted) return;
    sStarted = YES;
  }
  NSThread *thread = [[NSThread alloc] initWithBlock:^{
    if (listen) [self listenLoopWithPort:port];
    else [self loopWithPort:port];
  }];
  thread.name = @"tracesift-profiler";
  thread.qualityOfService = NSQualityOfServiceUtility;
  [thread start];
}

+ (void)loopWithPort:(int)port {
  for (;;) {
    @autoreleasepool {
      int fd = socket(AF_INET, SOCK_STREAM, 0);
      if (fd >= 0) {
        int one = 1;
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
        sockaddr_in address = {};
        address.sin_len = sizeof(address);
        address.sin_family = AF_INET;
        address.sin_port = htons((uint16_t)port);
        inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
        // Nothing listening yet is the normal case; the next attempt is the
        // whole recovery.
        if (connect(fd, (sockaddr *)&address, sizeof(address)) == 0) {
          [self serveOn:fd];
        }
        close(fd);
      }
      // A recording cut short by a dropped connection must not leave the
      // sampler running. Only when one was started — see HermesRoot().
      if (sSampling) [self stopSampling];
    }
    [NSThread sleepForTimeInterval:kRetryDelay];
  }
}

/// The phone's end of the CoreDevice tunnel: a unique-local (fc00::/7) IPv6 address on a utun interface. nil while no tunnel is up.
+ (BOOL)tunnelAddress:(sockaddr_in6 *)out {
  struct ifaddrs *list = NULL;
  if (getifaddrs(&list) != 0) return NO;
  BOOL found = NO;
  for (struct ifaddrs *entry = list; entry != NULL && !found; entry = entry->ifa_next) {
    if (entry->ifa_addr == NULL || entry->ifa_addr->sa_family != AF_INET6) continue;
    if (strncmp(entry->ifa_name, "utun", 4) != 0 || !(entry->ifa_flags & IFF_UP)) continue;
    const sockaddr_in6 *candidate = (const sockaddr_in6 *)entry->ifa_addr;
    if ((candidate->sin6_addr.s6_addr[0] & 0xfe) != 0xfc) continue;
    *out = *candidate;
    found = YES;
  }
  freeifaddrs(list);
  return found;
}

/// Serve on the tunnel address and take one CLI connection at a time. A
/// connection ends when the CLI goes away, which stops any sampler it left running.
+ (void)listenLoopWithPort:(int)port {
  for (;;) {
    @autoreleasepool {
      sockaddr_in6 address = {};
      if ([self tunnelAddress:&address]) {
        int server = socket(AF_INET6, SOCK_STREAM, 0);
        if (server >= 0) {
          int one = 1;
          setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
          address.sin6_len = sizeof(address);
          address.sin6_port = htons((uint16_t)port);
          if (bind(server, (sockaddr *)&address, sizeof(address)) == 0 && listen(server, 1) == 0) {
            char text[INET6_ADDRSTRLEN] = {};
            inet_ntop(AF_INET6, &address.sin6_addr, text, sizeof(text));
            NSLog(@"[TracesiftProfiler] listening on [%s]:%d for the CLI over the device tunnel", text, port);
            for (;;) {
              // CoreDevice tears the tunnel down when idle and brings it back under a new address,
              // leaving this socket bound to one that no longer exists.
              pollfd waiting = { server, POLLIN, 0 };
              int ready = poll(&waiting, 1, (int)(kRetryDelay * 1000));
              if (ready < 0 && errno != EINTR) break;
              if (ready <= 0) {
                sockaddr_in6 current = {};
                if (![self tunnelAddress:&current]
                    || memcmp(&current.sin6_addr, &address.sin6_addr, sizeof(in6_addr)) != 0) {
                  NSLog(@"[TracesiftProfiler] the device tunnel address changed; binding again");
                  break;
                }
                continue;
              }
              int fd = accept(server, NULL, NULL);
              if (fd < 0) break;
              setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
              setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
              [self serveOn:fd];
              close(fd);
              if (sSampling) [self stopSampling];
            }
          }
          close(server);
        }
      }
    }
    // No tunnel yet (cable not in, phone locked) is normal; look again.
    [NSThread sleepForTimeInterval:kRetryDelay];
  }
}

+ (BOOL)writeLine:(NSDictionary *)message to:(int)fd {
  NSData *json = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
  if (json == nil) return NO;
  NSMutableData *line = [json mutableCopy];
  [line appendBytes:"\n" length:1];
  const uint8_t *bytes = (const uint8_t *)line.bytes;
  size_t remaining = line.length;
  while (remaining > 0) {
    ssize_t written = send(fd, bytes, remaining, 0);
    if (written <= 0) return NO;
    bytes += written;
    remaining -= (size_t)written;
  }
  return YES;
}

+ (void)serveOn:(int)fd {
  NSBundle *main = NSBundle.mainBundle;
  NSString *appId = main.bundleIdentifier ?: @"unknown";
  NSString *device = UIDevice.currentDevice.name ?: @"iOS";
  NSString *bundle = @"main.jsbundle";
  if (![self writeLine:@{
        @"type" : @"hello",
        @"app" : appId,
        @"platform" : @"ios",
        @"bundle" : bundle,
        @"device" : device,
      }
                    to:fd]) {
    return;
  }

  NSMutableData *pending = [NSMutableData data];
  uint8_t buffer[4096];
  for (;;) {
    ssize_t count = recv(fd, buffer, sizeof(buffer), 0);
    if (count <= 0) return;
    [pending appendBytes:buffer length:(NSUInteger)count];
    for (;;) {
      NSRange newline = [pending rangeOfData:[NSData dataWithBytes:"\n" length:1]
                                     options:0
                                       range:NSMakeRange(0, pending.length)];
      if (newline.location == NSNotFound) break;
      NSData *line = [pending subdataWithRange:NSMakeRange(0, newline.location)];
      [pending replaceBytesInRange:NSMakeRange(0, newline.location + 1) withBytes:NULL length:0];
      if (line.length == 0) continue;
      id parsed = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
      if (![parsed isKindOfClass:NSDictionary.class]) continue;
      if (![self handle:(NSDictionary *)parsed on:fd]) return;
    }
  }
}

+ (BOOL)handle:(NSDictionary *)message on:(int)fd {
  NSNumber *idValue = [message[@"id"] isKindOfClass:NSNumber.class] ? message[@"id"] : @0;
  NSString *type = [message[@"type"] isKindOfClass:NSString.class] ? message[@"type"] : @"";
  NSString *failure = nil;

  if ([type isEqualToString:@"start"]) {
    double hz = [message[@"hz"] isKindOfClass:NSNumber.class] ? [message[@"hz"] doubleValue] : kDefaultHz;
    if (hz < 1 || hz > 10000) hz = kDefaultHz;
    failure = [self startSamplingAt:hz];
    if (failure) return [self writeLine:@{@"type" : @"error", @"id" : idValue, @"message" : failure} to:fd];
  } else if ([type isEqualToString:@"stop"]) {
    NSString *profile = [self dump:&failure];
    if (profile == nil) {
      return [self writeLine:@{@"type" : @"error", @"id" : idValue, @"message" : failure ?: @"no profile"} to:fd];
    }
    return [self sendProfile:profile id:idValue to:fd];
  }
  return YES;
}

+ (NSString *)startSamplingAt:(double)hz {
  auto *root = HermesRoot();
  if (root == nullptr) return @"Hermes is not available in this app (JSC is not supported).";
  root->enableSamplingProfiler(hz);
  sSampling = YES;
  return nil;
}

+ (void)stopSampling {
  sSampling = NO;
  if (auto *root = HermesRoot()) root->disableSamplingProfiler();
}

/// Straight to a string: unlike Android there is no temp file. Dumping clears
/// Hermes' buffer, so `disable` follows and a profile is collected once.
+ (NSString *)dump:(NSString **)failure {
  if (!sSampling) {
    *failure = @"no profile was started";
    return nil;
  }
  auto *root = HermesRoot();
  if (root == nullptr) {
    *failure = @"Hermes is not available in this app.";
    return nil;
  }
  std::ostringstream stream;
  root->dumpSampledTraceToStream(stream);
  sSampling = NO;
  root->disableSamplingProfiler();
  std::string text = stream.str();
  return [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];
}

+ (BOOL)sendProfile:(NSString *)profile id:(NSNumber *)idValue to:(int)fd {
  NSData *data = [profile dataUsingEncoding:NSUTF8StringEncoding];
  NSString *encoded = [data base64EncodedStringWithOptions:0];
  NSUInteger offset = 0;
  NSInteger sequence = 0;
  do {
    NSUInteger length = MIN(kChunkChars, encoded.length - offset);
    NSString *chunk = [encoded substringWithRange:NSMakeRange(offset, length)];
    offset += length;
    BOOL last = offset >= encoded.length;
    if (![self writeLine:@{
          @"type" : @"profile",
          @"id" : idValue,
          @"seq" : @(sequence),
          @"data" : chunk,
          @"last" : @(last),
        }
                      to:fd]) {
      return NO;
    }
    sequence += 1;
  } while (offset < encoded.length);
  return YES;
}

@end

/// The auto-start hook. `+load` is iOS's earliest entry point that needs no app
/// code; it only registers an observer. The gate is read once the app is
/// active, and nothing opens a socket unless the plist key is true.
@interface TracesiftProfilerBootstrap : NSObject
@end

@implementation TracesiftProfilerBootstrap

+ (void)load {
  __block id token = [NSNotificationCenter.defaultCenter
      addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                [NSNotificationCenter.defaultCenter removeObserver:token];
                token = nil;
                NSDictionary *info = NSBundle.mainBundle.infoDictionary;
                id enabled = info[kEnabledKey];
                if (![enabled respondsToSelector:@selector(boolValue)] || ![enabled boolValue]) return;
                id portValue = info[kPortKey];
                int port = [portValue respondsToSelector:@selector(intValue)] ? [portValue intValue] : kDefaultPort;
                if (port <= 0 || port > 65535) port = kDefaultPort;
                id transport = info[kTransportKey];
                BOOL listen = [transport isKindOfClass:NSString.class] && [transport isEqualToString:@"listen"];
                NSLog(@"[TracesiftProfiler] profiling enabled; %@ on port %d", listen ? @"serving the tracesift CLI" : @"dialling the tracesift CLI", port);
                [TracesiftProfilerLink startWithPort:port listen:listen];
              }];
}

@end
