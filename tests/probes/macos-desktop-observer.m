// Read-only metadata: no screen pixels, window titles, clipboard contents, or input injection.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <unistd.h>

int main(void) {
  // A closed stdout also terminates this process if the runner crashes.
  for (;;) {
    @autoreleasepool {
      NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
      NSMutableSet *pids = [NSMutableSet set];
      NSMutableArray *details = [NSMutableArray array];
      for (NSDictionary *window in windows) {
        NSNumber *pid = window[(id)kCGWindowOwnerPID];
        if (!pid) continue;
        [pids addObject:pid];
        [details addObject:@{
          @"pid": pid,
          @"bounds": window[(id)kCGWindowBounds] ?: @{},
          @"alpha": window[(id)kCGWindowAlpha] ?: @0,
          @"layer": window[(id)kCGWindowLayer] ?: @0
        }];
      }
      NSDictionary *record = @{
        @"time": @([[NSDate date] timeIntervalSince1970]),
        @"front": @([NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier),
        @"clipboard": @([NSPasteboard generalPasteboard].changeCount),
        @"windowOwners": pids.allObjects,
        @"details": details
      };
      NSData *data = [NSJSONSerialization dataWithJSONObject:record options:0 error:nil];
      puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
      fflush(stdout);
    }
    usleep(50000);
  }
}
