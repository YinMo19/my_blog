---
title: MacOS、Linux 上最简单的 hook function 方式
date: 2025-12-25 21:28:34
tags: ["reverse", "mac", "hook"]
showHero: true
heroStyle: "background"
---

> 本文地址：https://blog.yinmo19.top/posts/hook_mac_binary/
>
> YinMo 不对您复现本文产生的任何问题负责，请您搞清楚您正在做什么。您可能需要一些计算机常识与 C/Rust 基础来理解下面的文字。
>
> 另外我习惯在代码中写英文注释，如果您不能阅读中文也无需担心，网页翻译一般能够正确的处理正文，而代码块中的注释您应该也能直接读懂（虽然我的英文水平可能会闹点笑话，见谅）


在试图 hook 一个 MacOS 上的函数的时候，我找遍了全网都没有一个简明的可以直接使用的最小案例，这让我非常难受。看上去最能成功的一个也需要在 xcode 里面创建一个工程，选择 library 然后使用 obj-c 来写。

我并不是不喜欢 obj-c, 但是按照我的观念我需要的是一个比较底层的语言，比如 c 或者 rust 来进行操作系统级别的操作。按照目前的目标，应该是直接写一段最简单的 C/Rust 代码就能直接 hook 一个任意二进制中的函数。为了实现这个目标，我们需要一个工具叫做 insert_dylib(https://github.com/tyilo/insert_dylib)。它可以实现一个比较酷炫的动态链接库注入，而无需我们去手动使用
```sh
DYLD_INSERT_LIBRARIES=patch.dylib ./main
```
这样的运行方式。当然除了上面两个，我们还可以使用 optool，当然他们的使用方式有所不同，代码方面也是。 

## 准备工作
即使我们有 insert_dylib 这样的工具，我们也不能期望随便写一个动态链接库实现一个同名函数就能自动 hook，我们需要一些框架来帮我完成根据偏移量的注入、或者直接根据符号名称的实现替换。这里经过我几个小时的调研，最后选用了一个依赖看上去最少的框架 [dobby](https://github.com/jmpews/Dobby)。下载下来之后发现根本没有文档，网上的案例也鲜有 MacOS aarch64 的（可能是因为 M 系列芯片出来不久？）。似乎有人做了一个整合，叫做 [dylib_dobby_hook](https://github.com/marlkiller/dylib_dobby_hook)。 但是这个居然是一个 xcode 工程。

> Bro...... What I f**king NEED is just a header and dylib and a simple C file to build a shared dynamic library, OK? (Just kidding, a poor imitation of Tsoding ,ref: [tsoding's complains on ffi of Swift and C](https://www.youtube.com/watch?v=LTP5c4NqA8k))

anyway，我们还是根据唯一的 doc，也就是编译那一步，走 `cmake .. && make -j4` 的操作把 dylib 和 .a 文件构建出来吧。

## hook
由于 aslr，每次运行的基址都不一样，所以我们需要用一个 dyld 提供的函数 `_dyld_get_image_vmaddr_slide` 来获得对应 image 的基址。因为我们默认 hook 的都是最开始加载进去的那个，所以 index 直接写 0 就可以了。

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
不进行任何优化，或者记得在编译选项中加入 `-fno-inline`，因为不加这个参数优化后函数会直接内联到主函数中我们就没法 hook 函数调用了。接下来我们通过 objdump 来看看我们需要的内容
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
- `dobby-rs`  https://github.com/YinMo19/dobby-rs
- `dobby-sys` https://github.com/YinMo19/dobby-sys

我认为我需要改的更优雅一些，再考虑去给原作者提一个 pr（不知道他是否还接受维护），总之目前我自己的这个版本 **我自己** 是可用的。（说实话改了好多，我换掉了旧的 dylib（只更新了 MacOS，linux 还没换），更新了 header，然后重跑了 bindgen，还添加了一个新函数 `instrument`，虽然我觉得我设计 api 设计的并不好)

总之如果你现在想要复现我做的事情，你可以试试使用我的这个 `dobby-rs` crate。开一个 lib 的 rust crate，然后写入
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

## patch Code
是的，我们还可以实现指令级别的修改。由于年久失修，总之又是一番改库，现在这个功能也能用了。参考[我的上一篇 blog](https://blog.yinmo19.top/posts/arcaea_fragment/)，是迫害某游戏的，我们使用了直接原地 patch 的操作，of course it works, 但是我们依然可以通过非侵入式的方式修改。

还是一样需要准备好新的汇编的二进制，是小端序的 `[u8]` 序列，当然如果你愿意你也可以直接通过一个 0x0d000721 这样的 op code 然后直接 `to_le_bytes` 来完成，虽然我不是很推荐。然后我们直接使用
```rs
pub unsafe fn patch_code(addr: Address, code: &[u8]) -> Result<(), DobbyMemoryOperationError> 
```
这个函数来实现 patch。用起来很简单，指定好我们需要 patch 的地址，然后把小端序的二进制准备好就可以直接替换掉对应的位置了。亲测好用。

## 加载 image 的顺序
然后最后就是关于 MacOS 上 insert_dylib 的一些使用上的指南。dobby 实际上是将原本的二进制里面的那个函数实现进行了替换，无论原本是做什么，现在就是在这个函数里面调用我们新定义的函数。insert_dylib 做的事情是侵入式的，也就是整个二进制是作为第一个加载进内存的 image，因此我们使用 `_dyld_get_image_vmaddr_slide(0)` 来进行地址计算。

但是如果我们使用的是非侵入式方法，例如 `DYLD_INSERT_LIBRARIES=xxx.dylib ./a_binary` 这样的，那么实际上主二进制是作为第二个加载进去的 image。所以我们需要使用 `_dyld_get_image_vmaddr_slide(1)`。当然如果使用的是 symbol resolve 方法就不需要考虑这些了。这里我们可以通过下面的代码来确认这个行为。
```rs
extern "C" fn ctor() {
    let weird_add_offset_0 = (0x100000460 + unsafe { _dyld_get_image_vmaddr_slide(0) }) as Address;
    let weird_add_offset_1 = (0x100000460 + unsafe { _dyld_get_image_vmaddr_slide(1) }) as Address;
    let weird_add_sym = resolve_symbol("", "weird_add").unwrap();

    println!("using image 0: {weird_add_offset_0:?}, using 1: {weird_add_offset_1:?}");
    println!("correct answer: {weird_add_sym:?}");
}
```
我们看看运行结果
```sh
> DYLD_INSERT_LIBRARIES=target/release/libdobby_test.dylib ./main
using image 0: 0x204198460, using 1: 0x104140460
correct answer: 0x104140460
22
10

> insert_dylib target/release/libdobby_test.dylib main --all-yes && codesign -f -s - main_patched && ./main_patched
main_patched already exists. Overwrite it? [y/n] y
LC_CODE_SIGNATURE load command found. Remove it? [y/n] y
It doesn't seem like there is enough empty space. Continue anyway? [y/n] y
Added LC_LOAD_DYLIB to main_patched
using image 0: 0x102748460, using 1: 0x2027a4460
correct answer: 0x102748460
[1]    96417 illegal hardware instruction  ./main_patched
```
可以看到非侵入式的时候 `weird_add` 与使用第二个 image 是一样的，而侵入式方法则与第一个一样。


---
# Appendix
## Hook on Linux

事实上我们在 hook 的时候最重要的是，在原本的二进制的 main 运行前先把我们的实现注入，我们上文提到我们使用的是有 constructor 特性的这个 ctor 函数，这个函数在为了实现在 binary 前的提前调用，在 C 里面看上去平平无奇，但是在 rust 代码里面因为没有原生的
```c
__attribute__((constructor)) static void ctor(void) { }
```
这样的方法可供调用，因此我们实际上是通过指定了 link_section 这样的编译选项来实现的。注意，这个编译选项是平台相关的，在 mac 上我们使用的是
```rs
#[unsafe(link_section = "__DATA,__mod_init_func")]
#[unsafe(no_mangle)]
pub static INIT: extern "C" fn() = ctor;
```
而在 linux 上我们需要使用
```rs
#[unsafe(link_section = ".init_array")]
#[unsafe(no_mangle)]
pub static INIT: extern "C" fn() = ctor;
```
如果你不想手动处理这个，你可以使用 [ctor](https://docs.rs/ctor/latest/ctor/) 这个 crate，他有一个宏可以直接按照平台帮你处理好这个事。

除此之外，我们在 linux 上想要获取 aslr 的基址，由于 linux 上没有类似于 macos 上有 `mach-o/dyld`这样提供有 `_dyld_get_image_vmaddr_slide` 函数的库，所以我们需要使用 dlopen 之类的函数来获取程序运行的基址。

```rs
// src/base_addr.rs
// 
// add libc to your cargo.toml
use libc::{c_char, c_void};

#[repr(C)]
pub struct LinkMap {
    pub l_addr: usize,
    pub l_name: *mut c_char,
    pub l_ld: *mut c_void,
    pub l_next: *mut LinkMap,
    pub l_prev: *mut LinkMap,
}

const RTLD_DI_LINKMAP: i32 = 2;

pub fn get_main_base_address() -> usize {
    unsafe {
        let handle = libc::dlopen(std::ptr::null(), libc::RTLD_LAZY);
        if handle.is_null() {
            return 0;
        }

        let mut ptr: *mut LinkMap = std::ptr::null_mut();
        libc::dlinfo(handle, RTLD_DI_LINKMAP, &mut ptr as *mut _ as *mut c_void);

        let base_addr = (*ptr).l_addr;

        libc::dlclose(handle);
        base_addr
    }
}
```
由于 libc 这个库没有给出 `dlopen` 函数的返回值类型以及 `dlinfo` 函数的参数（在 linux 上实际上是一个 link_map），所以我们需要自己去定义这样的结构体类型 (注意需要满足 C ABI，`repr(C)`）将返回的这个 `*mut c_void` 指针进行一个类型转换（这里只需要 as 就可以了）才能正常的获取到我们需要的信息。

```rs
extern "C" fn ctor() {
    unsafe {
        hook(
            // analyse the binary and get the original function's Address
            // in this case is 0x12c9.
            (get_main_base_address() + 0x12c9) as Address, 
            // NOTE: define the replace function before.
            replace as Address,
        )
        .unwrap();
    }
}
```
这样就能完成一个我们想要的 hook。

linux 上编译获得的不是 dylib 文件而是 so 文件，虽然他们后缀名不同，但是实际上都是 dynamic link library（所以 windows 上叫 dll），所以用法一样吗？MacOS 我们介绍了 
```sh
# method 1, no need to change the original binary file
DYLD_INSERT_LIBRARIES=target/release/libdobby_test.dylib ./license
# method 2 and 3, need patch the original file.
insert_dylib target/release/libdobby_test.dylib license --all-yes
optool install -c load -p @executable_path/target/release/libdobby_test.dylib -t license
```
这样的三个方法来注入，而 linux 上我们没有 `insert_dylib` 也没有 `optool`， 但是第一种方法改个名字我们就可以继续使用
```sh
LD_PRELOAD=./target/release/libcamellia_hook.so ./main
```
是的，虽然名字不太一样，但是在 linux 上其实 `LD_PRELOAD` 就差不多等价于 mac 上的 `DYLD_INSERT_LIBRARIES`。


---

## Hook cpp binary
这里介绍的是 Cpp 的 binary hook，但是实际上想要介绍的实际上是对于除了 C 以外的语言的一些经验。每个语言都有自己的一些特殊的数据结构，例如 rust 有 Vec，cpp 则是 vector。虽然他们看上去都差不多，但是底层的实现肯定不可能一样。因此如果要 hook 这些语言相关的特殊数据结构，你就需要先搞懂这些语言底层是怎么实现这些数据结构的，以及这些数据结构是怎么样进行内存管理以及传参的。

最简单的案例就是传递引用的指针，这样 hook 的时候我们拿到的就是一个对应数据结构的指针，然后我们在 hook 的语言中定义对应的数据结构，然后根据指针拿到值之后进行对应的处理，按照原本的返回值类型返回相应的内容就可以了。这似乎并不困难，但是实际很多情况我们会遇到传值的函数，这里就需要注意了。这里我们就使用 cpp 和 rust 之间的 hook 和 function call 来看看这里面的一些细节。

```Cpp
#include <iostream>
#include <vector>
using namespace std;

vector<int> double_vec(vector<int> a) {
  for (size_t i = 0; i < a.size(); i++) {
    a[i] *= 2;
  }
  return a;
}

int main() {
  vector<int> a = double_vec(vector<int>{1, 2, 3, 4, 2});
  for (size_t i = 0; i < 5; i++) {
      cout << a[i] << endl;
  }
  return 0;
}
```
这是我们打算 hook 的函数。
```sh
c++ main.cpp -o main -O2 -fno-inline && ./main
2
4
6
8
4
```
构建编译然后跑。ok，所有都在预期内。（这里的 `c++` 在不同操作系统有不同实现，mac 上实际上是 `clang++`，`cc` 是 `clang`，另外在 mac 上其实 `gcc` 和 `cc` 和 `clang` 都是同一个东西，如果想在 mac 上使用真正的 `gcc` 请在 brew 里面下载 `gcc`。另外 brew 也可以装 `llvm`，虽然并不建议）
```asm
; > objdump -d main | grep double_vec --context 10
; Some irrelevant content has been omitted.

0000000000001410 <_Z10double_vecSt6vectorIiSaIiEE>:
    1410:	f3 0f 1e fa          	endbr64
    1414:	41 54                	push   %r12
    1416:	49 89 f0             	mov    %rsi,%r8
    1419:	49 89 fc             	mov    %rdi,%r12
    141c:	48 8b 3e             	mov    (%rsi),%rdi
    141f:	48 8b 76 08          	mov    0x8(%rsi),%rsi
    1423:	31 d2                	xor    %edx,%edx
    1425:	e8 d6 ff ff ff       	call   1400 <_ZNKSt6vectorIiSaIiEE4sizeEv.isra.0>
    142a:	48 89 c1             	mov    %rax,%rcx
    142d:	eb 0f                	jmp    143e <_Z10double_vecSt6vectorIiSaIiEE+0x2e>
    142f:	90                   	nop
; ... 
```
cpp 的编译结果有一些混淆，但是 `double_vec` 的字样依然还在，也就是说并没有 strip，我们依然可以使用`_Z10double_vecSt6vectorIiSaIiEE` 这个名字进行 symbol hook，当然这里我们不打算这样干，直接用偏移量 0x1410 即可。

好了，接下来来到最困难的时候了。我们会发现，每个平台上 cpp 的 vec 实现还是不一样的。如果详细展开我可以再写一篇 blog，所以这里我只演示 linux 版本的。这里我们看到的是 x86 操作系统，基于
```sh
> cc --version
cc (Ubuntu 11.4.0-1ubuntu1~22.04.2) 11.4.0
Copyright (C) 2021 Free Software Foundation, Inc.
This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
```
这个编译器版本的行为。（这是在我 mac 上的一个 orbstack 创建的虚拟机，如果你也想试试，但愿这可以成功复现。）

C++的 Vector 实现是 
```rs
#[repr(C)]
#[derive(Debug)]
pub struct CppVector<T> {
    pub start: *mut T,
    pub finish: *mut T,
    pub end_of_storage: *mut T,
}
```
这样的，因此我们先创建一个 `cxx_hook.rs` 文件创建一些胶水代码。
```rs
// please paste struct definition before here.
impl<T> CppVector<T> {
    pub fn len(&self) -> usize {
        (self.finish as usize - self.start as usize) / std::mem::size_of::<T>()
    }

    pub fn as_slice(&self) -> &[T] {
        unsafe { std::slice::from_raw_parts(self.start, self.len()) }
    }

    pub fn from_vec(mut v: Vec<T>) -> Self {
        v.shrink_to_fit();

        let len = v.len();
        let cap = v.capacity();
        let ptr = v.as_mut_ptr();

        std::mem::forget(v);

        unsafe {
            Self {
                start: ptr,
                finish: ptr.add(len),
                end_of_storage: ptr.add(cap),
            }
        }
    }
}
```
这里主要构建了几个常用的方法，第一个是获取长度，第二个是从 Cpp 的 Vector 转换为 rust 的类型，第三个是从 rust 的 Vec 转换到 Cpp 的 Vec。这里需要注意的是内存管理，由于我们期望的是从 rust 创建一个对象，并传递到 Cpp 接下来的内容，因此我们必须让 rust 的编译器忘掉这块内存，以期让 cpp 的编译器自己去 drop 掉函数返回的这块内容。

hook 的第一步是从 rust 里面调用 Cpp 的函数。我们上面给出的那个函数需要传递一个 Vector 给 cpp，它会将这个 Vector 内的每个数字乘二。
```rs
extern "C" fn ctor() {
    unsafe {
        let ori: fn(CppVector<i32>) -> CppVector<i32> =
            // get_main_base_address is define before,
            // dont forget to add it. 
            transmute((get_main_base_address() + 0x1410) as Address);

        println!(
            "ori: {:?}",
            ori(CppVector::from_vec((1..10).map(|i| i * i).collect())).as_slice()
        );
    }
}
```
所以我们先获取到这个函数的地址（当然你可以使用 symbol resolve，但是为了应付 symbol stripped 的情况，我这里还是使用偏移量。
```sh
> LD_PRELOAD=./target/release/libcamellia_hook.so ./main
ori: [2, 8, 18, 32, 50, 72, 98, 128, 162]
2
4
6
8
4
```
非常好，居然成功了。（说起来我正在写一个 hook cpp 写的奇怪 camellia 加密实现，所以这些内容其实是 hook 这个实现的一些实验性代码，所以如果你需要复现这些内容请自行修改二进制路径）

但是接下来才是大头，你会发现如果你只是正常的写一个 `fn(CppVector<i32>) -> CppVector<i32>` 这样签名的 `replace` function 你必然失败。究其原因还是看汇编源码
```asm 
0000000000001410 <_Z10double_vecSt6vectorIiSaIiEE>:
    1410:	f3 0f 1e fa          	endbr64

    ; protect %r12 which is used to store pointer of return value
    1414:	41 54                	push   %r12
    
    ; second param (ptr of vector a) store to %r8
    1416:	49 89 f0             	mov    %rsi,%r8

    ; first param (ptr of return value, SRet) store to %r12
    ; which is protect before (0x1414)
    1419:	49 89 fc             	mov    %rdi,%r12

    ; this part get the size of vector a,
    ; which matches our CppVector definition.
    141c:	48 8b 3e             	mov    (%rsi),%rdi
    141f:	48 8b 76 08          	mov    0x8(%rsi),%rsi
    1423:	31 d2                	xor    %edx,%edx
    1425:	e8 d6 ff ff ff       	call   1400 <_ZNKSt6vectorIiSaIiEE4sizeEv.isra.0>
    142a:	48 89 c1             	mov    %rax,%rcx

    ; do double calulation on each value of vector a.
    142d:	eb 0f                	jmp    143e <_Z10double_vecSt6vectorIiSaIiEE+0x2e>
    142f:	90                   	nop
    1430:	48 89 d6             	mov    %rdx,%rsi
    1433:	48 83 c2 01          	add    $0x1,%rdx ; i++
    1437:	e8 b4 ff ff ff       	call   13f0 <_ZNSt6vectorIiSaIiEEixEm.isra.0>
    143c:	d1 20                	shll   (%rax) ; val * 2 equals val << 1
    143e:	48 39 d1             	cmp    %rdx,%rcx
    1441:	75 ed                	jne    1430 <_Z10double_vecSt6vectorIiSaIiEE+0x20>

    ; put return addr on %rdi
    1443:	4c 89 e7             	mov    %r12,%rdi

    ; put input vector pointer on %rsi
    1446:	4c 89 c6             	mov    %r8,%rsi

    ; call a move constructor function,
    ; which move pointer of vector a to memory of return value (%rdi)
    1449:	e8 12 02 00 00       	call   1660 <_ZNSt6vectorIiSaIiEEC1EOS1_>

    ; return value is a pointer which placed on %rax
    144e:	4c 89 e0             	mov    %r12,%rax
    1451:	41 5c                	pop    %r12

    ; return 
    1453:	c3                   	ret
```
我们会发现实际上，编译器更改了我们的函数定义，现在实际上的函数签名是 `extern "C" fn(*mut CppVector<i32>, *mut CppVector<i32>) -> *mut CppVector<i32>`，所以
```rs
#[unsafe(no_mangle)]
extern "C" fn replace(
    ret_ptr: *mut CppVector<i32>,
    input_ptr: *mut CppVector<i32>,
) -> *mut CppVector<i32> {
    let input = unsafe { &*input_ptr };
    println!("[Rust] Hooked! Input Vector Len: {}", input.len());
    let new_vec_data: Vec<i32> = input.as_slice().iter().map(|&x| x * 3).collect();
    let new_cpp_vec = CppVector::from_vec(new_vec_data);
    unsafe {
        std::ptr::write(ret_ptr, new_cpp_vec);
    }
    ret_ptr
}

extern "C" fn ctor() {
    unsafe {
        let ori_ptr = hook(
            (get_main_base_address() + 0x1410) as Address,
            replace as Address,
        )
        .unwrap();
        let ori: fn(CppVector<i32>) -> CppVector<i32> = transmute(ori_ptr);

        println!(
            "ori: {:?}",
            ori(CppVector::from_vec((1..10).map(|i| i * i).collect())).as_slice()
        );
    }
}
```
这才是我们真正应该写的 hook 代码。

```sh
> LD_PRELOAD=./target/release/libcamellia_hook.so ./main
ori: [2, 8, 18, 32, 50, 72, 98, 128, 162]
[Rust] Hooked! Input Vector Len: 5
3
6
9
12
6
```
非常成功，一切都符合我们的预期。

> 但是这里有个问题，既然我们都已经确定了这个调用是通过返回值放在第一个参数来实现的，为什么我们最开始在 rust 里面调用这个 Cpp 函数，又或者我们 hook 的时候原函数作为返回值，我们依然还是使用 `let ori: fn(CppVector<i32>) -> CppVector<i32> = transmute(ori_ptr);` 来调用呢？ rust 其实 Vec 的实现也是默认一样的将 `fn(CppVector<i32>) -> CppVector<i32>`这个签名的函数自动更改为和 cpp 一样的方式，属实是瞎猫碰到死耗子了。
> 
> 这意味着，如果我们去掉 `extern "C"`，我们只需要如下代码
> ```rs
> > #[unsafe(no_mangle)]
> fn replace_rs(input: CppVector<i32>) -> CppVector<i32> {
>     println!(
>         "[Rust] Using rust vector model hooked! Input Vector Len: {}",
>         input.len()
>     );
>     let new_vec_data: Vec<i32> = input.as_slice().iter().map(|&x| x * 3).collect();
>     CppVector::from_vec(new_vec_data)
> }
> ```
> 就能成功 hook
> ```sh
> > LD_PRELOAD=./target/release/libcamellia_hook.so ./main
> ori: [2, 8, 18, 32, 50, 72, 98, 128, 162]
> [Rust] Using rust vector model hooked! Input Vector Len: 5
> 3
> 6
> 9
> 12
> 6
> ```
> 但是之前介绍的方法依然是重要的。因为你不能保证 swift, obj-c, 或者其他什么编译型语言他们的 vec 实现和 rust 或者 cpp 一样，所以我们依然要掌握分析汇编到写出一致性的 hook 代码的能力。

而对于 macos，巧妙的是 Vector 实现依然一致，可能这里面有一些更深刻的原因，比如他们都是编译到 ir 然后由 llvm 后端来进行编译，但我确实不了解这些，只能说非常凑巧。 但如果你使用`extern "C" fn(*mut CppVector<i32>, *mut CppVector<i32>) -> *mut CppVector<i32>` 在 aarch64 架构下的 MacOS 必然失败，因为 Mac 上**至少在这个场景下，编译器并不会改变函数签名**，所以你可以
```rs
#[unsafe(no_mangle)]
// pub fn replace_cpp( // remove extern "C" is ok.
pub extern "C" fn replace_cpp(
    input: CppVector<i32>,
) -> CppVector<i32> { }
```
直接这样。


---

> thanks to dobby, dobby-rs
>
> 对于 x86 的 mac 用户可以考虑使用 [rd-route](https://github.com/rodionovd/rd_route) 这个 C 库，并且可以考虑看看 https://tfin.ch/blog/HookingCFunctionsAtRuntime 这篇文章，我从这篇文章也学了不少。
