---
title: 使用捕获异常信号进行二进制插桩
date: 2026-02-06 21:28:34
tags: ["reverse", "mac", "hook", "instrument"]
showHero: true
heroStyle: "background"
---

> 本文地址：https://blog.yinmo19.top/posts/hook_mac_sign/
>
> YinMo 不对您复现本文产生的任何问题负责，请您搞清楚您正在做什么。您可能需要一些计算机常识与 C/Rust 基础来理解下面的文字。
>
> 另外我习惯在代码中写英文注释，如果您不能阅读中文也无需担心，网页翻译一般能够正确的处理正文，而代码块中的注释您应该也能直接读懂（虽然我的英文水平可能会闹点笑话，见谅）

接上一篇的 hook binary，这一篇主要是关于一种成功率更高一些的 instrument 方法。

尤其是，如果看过之前那期关于 Arcaea api 动态调试的文章的话，肯定会忍不住使用上一期的方法进行自动化 hook 解密。但是实际上那样会失败。可能是因为指令排的太密，或者是什么奇怪的原因，总之插桩总会失败，导致各种 panic。

恰巧前段时间，刚好看到了 MacOS 的 15.0-2 暴露了一个 CVE，关于 gcore 权限过高可以直接 dump 一个失败的进程的内存到硬盘里面。于是这篇文章的原理就基于这个想法。我们可以直接在原本的二进制里面把某一条 opcode 直接改为一条无意义指令或者直接brk，然后注册一个错误处理的函数，并在错误处理的函数里面将内存快照以及各种寄存器操作，然后再重新将计数器 pc 改到 err opcode 的 +4 位置，继续运行。相当于程序爆了，但是被我们又救回来了，并且继续跑。至于爆了之后到回到程序继续跑，中途我们所做的所有操作，对程序都是不可知的。

这里我们patch 一条 opcode 当然可以用任何方式，比如直接去改 binary。但是在 macos 上需要重签名，有点麻烦，所以我们还是使用 dobby 来patchcode。
```c
#include <stdio.h>

__attribute__((noinline)) int calc(int a, int b) {
    int sum = a + b;
    return sum * 7;
}

int main(void) {
    printf("%d\n", calc(4, 5));
    return 0;
}
```
这是这次的受害者。汇编如下
```asm
> objdump -d examples/bin/calc

examples/bin/calc:	file format mach-o arm64

Disassembly of section __TEXT,__text:

0000000100000460 <_calc>:
100000460: 0b000028    	add	w8, w1, w0
100000464: 531d7109    	lsl	w9, w8, #3
100000468: 4b080120    	sub	w0, w9, w8
10000046c: d65f03c0    	ret

0000000100000470 <_main>:
100000470: d10083ff    	sub	sp, sp, #0x20
100000474: a9017bfd    	stp	x29, x30, [sp, #0x10]
100000478: 910043fd    	add	x29, sp, #0x10
10000047c: 52800080    	mov	w0, #0x4                ; =4
100000480: 528000a1    	mov	w1, #0x5                ; =5
100000484: 97fffff7    	bl	0x100000460 <_calc>
100000488: f90003e0    	str	x0, [sp]
10000048c: 90000000    	adrp	x0, 0x100000000 <_printf+0x100000000>
100000490: 9112d000    	add	x0, x0, #0x4b4
100000494: 94000005    	bl	0x1000004a8 <_printf+0x1000004a8>
100000498: 52800000    	mov	w0, #0x0                ; =0
10000049c: a9417bfd    	ldp	x29, x30, [sp, #0x10]
1000004a0: 910083ff    	add	sp, sp, #0x20
1000004a4: d65f03c0    	ret

Disassembly of section __TEXT,__stubs:

00000001000004a8 <__stubs>:
1000004a8: 90000030    	adrp	x16, 0x100004000 <_printf+0x100004000>
1000004ac: f9400210    	ldr	x16, [x16]
1000004b0: d61f0200    	br	x16
```
我们选取 100000468 `sub	w0, w9, w8` 作为 hack 的地址，我们的目的是查看一下几个寄存器打个日志。

```rs
use dobby_rs::{Address, patch_code};
use libc::{SA_SIGINFO, SIGILL, SIGTRAP, sigaction, siginfo_t, ucontext_t};
use std::mem;

static mut HOOK_ADDR: usize = 0;
mod dyld {
    unsafe extern "C" {
        pub fn _dyld_get_image_vmaddr_slide(image_index: u32) -> isize;
    }
}

#[unsafe(no_mangle)]
extern "C" fn exception_handler(_sig: i32, _info: *mut siginfo_t, ctx: *mut libc::c_void) {
    unsafe {
        let context = &mut *(ctx as *mut ucontext_t);
        let m = &mut *context.uc_mcontext;
        let pc = m.__ss.__pc as usize;

        if (pc & !0x3) == (HOOK_ADDR & !0x3) {
            println!(
                "[+] hook: w0 = {}, w9 = {}, w8 = {}",
                m.__ss.__x[0], m.__ss.__x[9], m.__ss.__x[8]
            );

            m.__ss.__x[0] = m.__ss.__x[9] - m.__ss.__x[8];
            m.__ss.__pc += 4;
            return;
        }
    }
}

#[unsafe(link_section = "__DATA,__mod_init_func")]
#[unsafe(no_mangle)]
pub static INIT: extern "C" fn() = ctor;

#[unsafe(no_mangle)]
extern "C" fn ctor() {
    let slide = unsafe { dyld::_dyld_get_image_vmaddr_slide(1) };
    let patchaddr = (slide + 0x0100000468) as usize;

    unsafe { HOOK_ADDR = patchaddr };

    unsafe {
        let mut sa: sigaction = mem::zeroed();
        sa.sa_sigaction = exception_handler as usize;
        sa.sa_flags = SA_SIGINFO;
        sigaction(SIGTRAP, &sa, std::ptr::null_mut());
        sigaction(SIGILL, &sa, std::ptr::null_mut());

        patch_code(patchaddr as Address, &[0x00, 0x00, 0x20, 0xD4]).unwrap();
    }
}
```
按照上述的逻辑，就能看懂在做什么。

比较需要注意的一点是，因为我们把原本的那个指令变为了brk,我们在异常处理的最后需要把最后一条的逻辑补上。

这里主要是使用了 libc 绑定进行 sigaction 的注册，然后在 exception_handler 里面进行寄存器的读取与修改。实际运行效果非常好
```sh
> DYLD_INSERT_LIBRARIES="$PWD/target/release/libsighook_test.dylib" ./examples/bin/calc
[+] hook: w0 = 4, w9 = 72, w8 = 9
63
```
这个方法需要在内核态进行补丁，因此每次触发这个断点相当于进行了从用户态切换到内核态，因此可能大量的触发断点会性能不佳。但是对于一些 dobby instrument 会失败的情况，这个方法反而成功率更高。

## Sighook
基于这个想法，我开发了一个 hook 库，[sighook](https://github.com/YinMo19/sighook)，用法和 dobby 类似。使用
```sh
cargo add sighook
```
之后，就可以快速的 patch 和 instrument。我暴露了四个函数，每个函数都有一个 example 可以在仓库里面看到用法。目前支持 MacOS aarch64, Linux x86-64/aarch64。之后可能会补 android 和 ios，取决于能不能做得出来。

一个经典的案例是
```rs
use sighook::{HookContext, instrument_no_original};

#[cfg(not(all(target_os = "linux", target_arch = "aarch64")))]
const ADD_INSN_OFFSET: u64 = 0x14;

extern "C" fn replace_logic(_address: u64, ctx: *mut HookContext) {
    unsafe {
        #[cfg(target_arch = "aarch64")]
        {
            (*ctx).regs.named.x0 = 99;
        }

        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            (*ctx).rax = 99;
        }
    }
}

#[used]
#[cfg_attr(target_os = "macos", unsafe(link_section = "__DATA,__mod_init_func"))]
#[cfg_attr(target_os = "linux", unsafe(link_section = ".init_array"))]
static INIT_ARRAY: extern "C" fn() = init;

extern "C" fn init() {
    unsafe {
        let target_address = {
            #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
            {
                let symbol = libc::dlsym(libc::RTLD_DEFAULT, c"calc_add_insn".as_ptr());
                if symbol.is_null() {
                    return;
                }
                symbol as u64
            }

            #[cfg(not(all(target_os = "linux", target_arch = "aarch64")))]
            {
                let symbol = libc::dlsym(libc::RTLD_DEFAULT, c"calc".as_ptr());
                if symbol.is_null() {
                    return;
                }
                symbol as u64 + ADD_INSN_OFFSET
            }
        };

        let _ = instrument_no_original(target_address, replace_logic);
    }
}
```
目前还在开发早期，不过已经看上去挺好用的了。都做 hack 了大家都不在意 unsafe 了吧（笑， 我在代码里面 static mut 什么的可是随便写了哦..
