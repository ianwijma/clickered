# macOS build of clickered-helper: one universal (arm64 + x86_64) binary.
# Needs only the Xcode command line tools (xcode-select --install).
#
# Objective-C memory management: ARC (-fobjc-arc). CoreFoundation objects in
# helper.m are released by hand.

ifeq ($(origin CC),default)
CC      := clang
endif
ARCHS   ?= -arch arm64 -arch x86_64
MINOS   ?= 11.0
CFLAGS  ?= -O2
CFLAGS  += -std=c11 -fobjc-arc -fblocks -Wall -Wextra -mmacosx-version-min=$(MINOS)
FRAMEWORKS := -framework AppKit -framework ApplicationServices -framework CoreGraphics \
              -framework CoreFoundation
OUT     := ../../resources/clickered-helper

all: $(OUT)

$(OUT): helper.m Makefile
	@mkdir -p $(dir $(OUT))
	$(CC) $(ARCHS) $(CFLAGS) -o $@ helper.m $(FRAMEWORKS)

# Show the architectures and minimum OS of the built binary.
check: $(OUT)
	lipo -info $(OUT)
	otool -l $(OUT) | grep -A4 -E 'LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX' | grep -E 'minos|version' || true

clean:
	rm -f $(OUT)

.PHONY: all check clean
