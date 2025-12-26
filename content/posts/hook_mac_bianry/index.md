---
title: MacOS 上最简单的 hook function 方式
date: 2025-12-25 21:28:34
tags: ["reverse", "mac", "hook"]
showHero: true
heroStyle: "background"
---

在试图 hook 一个 MacOS 上的函数的时候，我找遍了全网都没有一个简明的可以直接实现的最小案例，让我非常难受。最看上去能成功的一个也需要在 xcode 里面建一个工程，选择 library 然后用 obj-c 来写。这让我觉得非常不对劲，为什么这样一个本应该非常简单的功能会出现这样的问题？这肯定是不对的。

我们的目标应该是直接写一个最简单的 C/Rust 代码，然后就能直接 hook 一个函数。为了实现这个目标，我们需要一个工具叫做 insert_dylib(https://github.com/tyilo/insert_dylib)。它可以实现一个比较酷炫的动态链接库注入，而无需我们去手动使用
```sh
DYLD_INSERT_LIBRARIES=patch.dylib ./main
```
这样的运行方式。 anyway，让我们开始吧。

## 准备工作
即使我们有 insert_dylib 这样的工具，我们也不能期望随便写一个动态链接库实现一个同名函数就能自动 hook，我们需要一些框架来帮我完成根据地址的注入，根据偏移量的注入。这里经过我几个小时的调研，最后选用了一个依赖看上去最少的框架 [dobby](https://github.com/jmpews/Dobby)。下载下来之后发现根本没有文档，网上也找不到一个最简单的案例。似乎有人做了一个整合，叫做 [dylib_dobby_hook](https://github.com/marlkiller/dylib_dobby_hook) 但是这个居然是一个 xcode 工程。

Bro...... What I f**king NEED is just a header and dylib and a simple C file to build a shared dynamic library, OK?

anyway，我们还是根据唯一的 doc，也就是编译那一步，走 cmake .. && make -j4的操作把 dylib 和 .a 文件构建出来吧。

## hook
由于 alsr，每次运行的基址都不一样，所以我们需要用一个 dyld 提供的函数 `_dyld_get_image_vmaddr_slide` 来获得对应 image 的基址。因为我们默认 hook 的都是最开始加载进去的那个，所以 index 直接写 0 就可以了。

我们先从偏移量开始 hook。写一个最简单的 C 文件
```c
#include <stdio.h>

int weird_add(int a, int b) { return a + 2 * b; }
int weird_sub(int a, int b) { return a - 2 * b; }
int weird_mul(int a, int b) { return a * 2 * b; }
int weird_div(int a, int b) { return a / 2 * b; }
int weird_mod(int a, int b) { return a % 2 * b; }

int main() {
  printf("%d\n", weird_add(4, 9));
  printf("%d\n", weird_div(10, 2));
  return 0;
}
```
目前我们的输出应该是这样的
```sh
cc main.c -o main && ./main
22
10
```
不进行任何优化，这很重要，因为优化后函数内联我们就没法 hook 调用了。接下来我们通过 objdump 来看看我们需要的内容
```asm
; > objdump -d main

; main:	file format mach-o arm64

; Disassembly of section __TEXT,__text:

0000000100000460 <_weird_add>:
100000460: d10043ff    	sub	sp, sp, #0x10
100000464: b9000fe0    	str	w0, [sp, #0xc]
100000468: b9000be1    	str	w1, [sp, #0x8]
10000046c: b9400fe8    	ldr	w8, [sp, #0xc]
100000470: b9400bea    	ldr	w10, [sp, #0x8]
100000474: 52800049    	mov	w9, #0x2                ; =2
100000478: 1b0a7d29    	mul	w9, w9, w10
10000047c: 0b090100    	add	w0, w8, w9
100000480: 910043ff    	add	sp, sp, #0x10
100000484: d65f03c0    	ret

000000010000052c <_main>:
; ... prev too long, wrapped.
100000544: 52800080    	mov	w0, #0x4                ; =4
100000548: 52800121    	mov	w1, #0x9                ; =9
10000054c: 97ffffc5    	bl	0x100000460 <_weird_add>
100000550: 910003e9    	mov	x9, sp
100000554: aa0003e8    	mov	x8, x0
100000558: f9000128    	str	x8, [x9]
10000055c: 90000000    	adrp	x0, 0x100000000 <_printf+0x100000000>
100000560: 9116b000    	add	x0, x0, #0x5ac
100000564: f9000be0    	str	x0, [sp, #0x10]
100000568: 9400000e    	bl	0x1000005a0 <_printf+0x1000005a0>
10000056c: 52800140    	mov	w0, #0xa                ; =10
100000570: 52800041    	mov	w1, #0x2                ; =2
100000574: 97ffffd8    	bl	0x1000004d4 <_weird_div>
```

可以看到实际上调用的地址是 0x100000460，所以我们实际上应该 hook 的指针应该是
```c
_dyld_get_image_vmaddr_slide(0) + 0x100000460
```
既然这样，我们打开一个新的目录，然后将之前构建好的 libdobby.dylib 和 dobby.h 文件放入这个文件夹，然后随便打开一个新的 C file，这里我叫 patch.c
```c
#include "dobby.h"
#include <mach-o/dyld.h>
#include <stdio.h>

int real_add(int a, int b) {
  printf("Calling replacement function!\n");
  return a + b;
}

int real_div(int a, int b) {
  printf("Calling real div function!\n");
  return a / b;
}

__attribute__((constructor)) static void ctor(void) {
  intptr_t weird_add_ptr = _dyld_get_image_vmaddr_slide(0) + 0x100000460;
  intptr_t weird_div_ptr = (intptr_t)DobbySymbolResolver("", "weird_div");
  DobbyHook((void *)weird_add_ptr, real_add, (void **)&weird_add_ptr);
  DobbyHook((void *)weird_div_ptr, real_div, (void **)&weird_div_ptr);
}
```

我们需要使用 constructor 来让这个 dylib 在刚加载进去就 hook 掉对应的地址，具体实现由 DobbyHook 来完成。就这么短。但是接下来的重点来了。如果我们只是当成正常的 shared dynamic library 来构建，会一直失败，遇到什么 Rpath not found 之类的错误。这里我们需要用到 install_name_tool 来更改一些奇妙的加载路径。
```shell
cc -shared -o patch.dylib patch.c ./libdobby.dylib -O2
install_name_tool -change @rpath/libdobby.dylib @loader_path/libdobby.dylib patch.dylib
insert_dylib @loader_path/patch.dylib main main_patched --all-yes
```
然后我们再运行
```sh
> ./main_patched
Calling replacement function!
13
Calling real div function!
5
```
就能看到已经被 hack 掉的第一个函数。我不禁吐槽，这么一个最基础的 demo 为什么不会出现在搜索引擎的前几条，最后还是自己摸出来的？

## rust 篇
由于我日常写 rust 更加熟练一些，而且 dobby 也有 rust binding，所以我们也可以试一下。但是这个 bining 非常坑，上一次更新还是几年前，构建都过不去，而且文档也是几乎如同啥也没写。最基础的 demo 也没有。

首先，由于第一个 pr，这个项目本身 link 的 dobby c dylib 是 ios 版本的，所以我 fork 了一份，将其更改到 Mac 的版本，并且由于新版本的 xcode 工具链已经抛弃了使用 -libstdc++ 而是实际使用 -libc++ 所以我们还需要更改 build.rs 里面的编译命令。
- dobby-rs  https://github.com/YinMo19/dobby-rs
- dobby-sys https://github.com/YinMo19/dobby-sys
我认为我需要改的更优雅一些，再考虑去给原作者提一个 pr（不知道他是否还接受维护），总之目前我自己的这个版本是可用的。

开一个 lib 的 rust crate，然后写入
```toml
[package]
name = "dobby_test"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
dobby-rs = { git = "https://github.com/YinMo19/dobby-rs.git" }

[profile.release]
opt-level = 3
strip = true
lto = true
```
接下来我们就可以开始 hook 了。
```rs
use dobby_rs::{Address, hook, resolve_symbol};

unsafe extern "C" {
    fn _dyld_get_image_vmaddr_slide(image_index: u32) -> isize;
}

extern "C" fn real_add(a: u64, b: u64) -> u64 {
    println!("[Rust Hook] Intercepted a: {}, b: {}", a, b);
    a + b
}

extern "C" fn real_div(a: i32, b: i32) -> i32 {
    println!("[Rust Hook] Intercepted a: {}, b: {}", a, b);
    a / b
}


#[unsafe(link_section = "__DATA,__mod_init_func")]
#[unsafe(no_mangle)]
pub static INIT: extern "C" fn() = ctor;

extern "C" fn ctor() {
    let target_addr = (0x100000460 + unsafe { _dyld_get_image_vmaddr_slide(0) }) as Address;
    let weird_div = resolve_symbol("", "weird_div").unwrap();

    unsafe {
        hook(target_addr, real_add as Address).unwrap();
        hook(weird_div, real_div as Address).unwrap();
    }
}
```
这里我们展示了两种 hook 办法，一种是基于 offset，另外一个直接根据 symbol，能够实现更加简单的 hook 办法。代码很短，主要是从 C 导入 dyld 那个函数，解析地址，然后 hook 并导出为实际的 hook 方法。rust 构建的 dylib 可以直接 insert_dylib 
```sh
cargo build --release
insert_dylib target/release/libdobby_test.dylib main --all-yes

./main_patched
[Rust Hook] Intercepted a: 4, b: 9
13
[Rust Hook] Intercepted a: 10, b: 2
5
```

就是这样，有了这样的方法我们可以简单的去做任何事情，包括hook 一个函数改一些汇编，给一个 binary 实现新功能，hack 一些函数等等。


> thanks to dobby, dobby-rs
>
> 对于 x86 的 mac 用户可以考虑使用 [rd-route](https://github.com/rodionovd/rd_route) 这个 C 库，并且可以考虑看看 https://tfin.ch/blog/HookingCFunctionsAtRuntime 这篇文章，我从这篇文章也学了不少。
