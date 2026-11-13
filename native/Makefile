CC      ?= cc
CFLAGS  ?= -O2
CFLAGS  += -std=c11 -Wall -Wextra
PKGS    := x11 xi xtst
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
