/* Test-only: inject input that appears to come from the Xvfb's own (non-XTEST)
 * slave devices, via XTestFakeDevice* on the "Xvfb mouse"/"Xvfb keyboard" XI1
 * devices. Used to exercise the helper's physical-input capture in Xvfb.
 *   physinput b BTN 1|0     button press/release
 *   physinput m X Y         absolute motion
 *   physinput k CODE 1|0    key press/release
 * Build: cc -o physinput physinput.c $(pkg-config --libs x11 xi xtst)
 */
#include <X11/Xlib.h>
#include <X11/extensions/XInput.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static XDevice *open_named(Display *d, const char *name)
{
    int n;
    XDeviceInfo *l = XListInputDevices(d, &n);
    for (int i = 0; i < n; i++)
        if (strcmp(l[i].name, name) == 0) return XOpenDevice(d, l[i].id);
    return NULL;
}

int main(int argc, char **argv)
{
    Display *d = XOpenDisplay(NULL);
    if (!d || argc < 4) return 2;
    int a = atoi(argv[2]), b = atoi(argv[3]);
    if (argv[1][0] == 'k') {
        XDevice *kb = open_named(d, "Xvfb keyboard");
        if (!kb) return 3;
        XTestFakeDeviceKeyEvent(d, kb, (unsigned)a, b, NULL, 0, CurrentTime);
    } else {
        XDevice *ms = open_named(d, "Xvfb mouse");
        if (!ms) return 3;
        if (argv[1][0] == 'b') {
            XTestFakeDeviceButtonEvent(d, ms, (unsigned)a, b, NULL, 0, CurrentTime);
        } else {
            int ax[2] = {a, b};
            XTestFakeDeviceMotionEvent(d, ms, False, 0, ax, 2, CurrentTime);
        }
    }
    XSync(d, False);
    XCloseDisplay(d);
    return 0;
}
