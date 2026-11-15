# Windows helper: resources/clickered-helper.exe
#
#   Linux (cross):            make -C native/win          (uses x86_64-w64-mingw32-gcc)
#   MSYS2 / Git-for-Windows:  make -C native/win           (uses gcc)  or  mingw32-make -C native/win
#   Override:                 make -C native/win CC=...
#
# Static libgcc, no third-party DLLs: the exe only imports Windows system DLLs.

ifeq ($(origin CC),default)
CC := $(if $(shell command -v x86_64-w64-mingw32-gcc 2>/dev/null),x86_64-w64-mingw32-gcc,gcc)
endif
CFLAGS  ?= -O2
CFLAGS  += -std=c11 -Wall -Wextra
LDFLAGS += -mwindows -static -static-libgcc -s
LIBS    := -luser32 -lgdi32 -ldwmapi -lole32 -lwinmm
OUT     := ../../resources/clickered-helper.exe

all: $(OUT)

$(OUT): helper.c Makefile
	@mkdir -p $(dir $(OUT))
	$(CC) $(CFLAGS) -o $@ helper.c $(LDFLAGS) $(LIBS)

clean:
	rm -f $(OUT)

.PHONY: all clean
