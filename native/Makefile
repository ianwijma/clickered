CC      ?= cc
CFLAGS  ?= -O2
CFLAGS  += -std=c11 -Wall -Wextra
PKGS    := x11 xi xtst
ifneq ($(MAKECMDGOALS),clean)
ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo ok),)
$(error pkg-config could not find $(PKGS). Install pkg-config and the X11 dev packages, e.g. sudo apt install pkg-config libx11-dev libxi-dev libxtst-dev)
endif
endif
LIBS    := $(shell pkg-config --libs $(PKGS)) -lm
INCS    := $(shell pkg-config --cflags $(PKGS))
OUT     := ../resources/clickered-helper

all: $(OUT)

$(OUT): helper.c Makefile
	@mkdir -p $(dir $(OUT))
	$(CC) $(CFLAGS) $(INCS) -o $@ helper.c $(LIBS)

clean:
	rm -f $(OUT)

.PHONY: all clean
