#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <errno.h>
#import <unistd.h>

static void result(NSDictionary *value) __attribute__((noreturn));
static void result(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  const uint8_t *bytes = data.bytes;
  NSUInteger remaining = data.length;
  while (remaining) {
    ssize_t written = write(STDOUT_FILENO, bytes, remaining);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) exit(1);
    bytes += written;
    remaining -= written;
  }
  exit(0);
}

int main(void) {
  @autoreleasepool {
    if (!AXIsProcessTrusted()) result(@{@"error": @"permission"});
    NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!application) result(@{@"error": @"unavailable"});
    pid_t pid = application.processIdentifier;
    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
    NSInteger before = pasteboard.changeCount;
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    CGEventRef down = CGEventCreateKeyboardEvent(source, 8, true); // ANSI C
    CGEventRef up = CGEventCreateKeyboardEvent(source, 8, false);
    if (source) CFRelease(source);
    if (!down || !up) {
      if (down) CFRelease(down);
      if (up) CFRelease(up);
      result(@{@"error": @"unavailable"});
    }
    CGEventSetFlags(down, kCGEventFlagMaskCommand);
    CGEventSetFlags(up, kCGEventFlagMaskCommand);
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid)
      result(@{@"error": @"focus_changed"});
    CGEventPostToPid(pid, down);
    CGEventPostToPid(pid, up);
    CFRelease(down);
    CFRelease(up);

    // Wait for this copy to update the pasteboard, never reuse its previous text.
    // Return as soon as data arrives; the deadline bounds apps that ignore Copy.
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 1.0;
    while (NSProcessInfo.processInfo.systemUptime < deadline) {
      if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid)
        result(@{@"error": @"focus_changed"});
      NSInteger current = pasteboard.changeCount;
      if (current != before) {
        if (pasteboard.types.count && ![pasteboard availableTypeFromArray:@[NSPasteboardTypeString]])
          result(@{@"error": @"no_text"});
        NSString *text = [pasteboard stringForType:NSPasteboardTypeString];
        if (text && pasteboard.changeCount == current) {
          if (![text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length)
            result(@{@"error": @"empty"});
          if (text.length > 32000) result(@{@"error": @"too_large"});
          result(@{@"copied": @YES, @"text": text});
        }
      }
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
    }
    result(@{@"error": @"no_update"});
  }
}
