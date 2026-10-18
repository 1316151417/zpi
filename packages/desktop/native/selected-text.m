#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static void result(NSDictionary *value) __attribute__((noreturn));
static void result(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
  exit(0);
}

int main(void) {
  @autoreleasepool {
    if (!AXIsProcessTrusted()) result(@{@"error": @"permission"});
    NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!application) result(@{@"error": @"unavailable"});
    AXUIElementRef target = AXUIElementCreateApplication(application.processIdentifier);
    AXUIElementSetMessagingTimeout(target, 1);
    CFTypeRef focused = NULL;
    AXError status = AXUIElementCopyAttributeValue(target, kAXFocusedUIElementAttribute, &focused);
    CFRelease(target);
    if (status != kAXErrorSuccess || !focused || CFGetTypeID(focused) != AXUIElementGetTypeID()) {
      if (focused) CFRelease(focused);
      result(@{@"error": @"unavailable"});
    }
    AXUIElementSetMessagingTimeout((AXUIElementRef)focused, 1);
    CFTypeRef selected = NULL;
    status = AXUIElementCopyAttributeValue((AXUIElementRef)focused, kAXSelectedTextAttribute, &selected);
    CFRelease(focused);
    if (status != kAXErrorSuccess || !selected || CFGetTypeID(selected) != CFStringGetTypeID()) {
      if (selected) CFRelease(selected);
      result(@{@"error": @"unavailable"});
    }
    NSString *text = [(__bridge NSString *)selected copy];
    CFRelease(selected);
    if (![text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length)
      result(@{@"error": @"empty"});
    if (text.length > 32000) result(@{@"error": @"too_large"});
    result(@{@"text": text});
  }
}
