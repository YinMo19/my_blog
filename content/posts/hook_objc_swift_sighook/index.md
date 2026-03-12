---
title: 用 sighook 在 macOS 上同时 hook ObjC/Swift 网络请求
date: 2026-03-10 23:58:00
tags: ["reverse", "mac", "hook", "objc", "swift", "rust"]
showHero: true
heroStyle: "background"
---

> 本文地址：https://blog.yinmo19.top/posts/hook_objc_swift_sighook/
>
> YinMo 不对您复现本文产生的任何问题负责，请您搞清楚您正在做什么。您可能需要一些计算机常识与 C/Rust 基础来理解下面的文字。
>
> 另外我习惯在代码中写英文注释，如果您不能阅读中文也无需担心，网页翻译一般能够正确的处理正文，而代码块中的注释您应该也能直接读懂（虽然我的英文水平可能会闹点笑话，见谅）

接上一篇，这次是一个关于 objc 和 swift 的 hook。
> 那有人就要问了，既然要做 objc 的 hook 直接 method swizzling 不就好了，你搁这 hook 啥呢.....
>
> ok 也是被讽刺到了，所以其实这里确实用 method swizzling 确实简单，但是我的方法比较普适，另外也是展现一下我的 sighook 框架的能力，另外也想展示一下单步 instrument 的高明之处。

## objc victim
按照惯例先手搓一位受害者。由于 swift 底层还有不少调用 objc 的，因此我们这里先从 objc 出发。
```objc
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>

int main(void) {
    @autoreleasepool {
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);

        NSURL *url =
            [NSURL URLWithString:@"https://httpbin.org/get?source=objc_demo"];
        NSURLRequest *request = [NSURLRequest requestWithURL:url];

        NSURLSessionDataTask *task = [[NSURLSession sharedSession]
            dataTaskWithRequest:request
              completionHandler:^(NSData *_Nullable data,
                                  NSURLResponse *_Nullable response,
                                  NSError *_Nullable error) {
                NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
                long status = http ? (long)http.statusCode : -1;
                NSLog(@"[objc-demo] status=%ld error=%@", status, error);

                NSString *text =
                    [[NSString alloc] initWithData:data
                                          encoding:NSUTF8StringEncoding];
                NSLog(@"[objc-demo] body=%@", text);

                dispatch_semaphore_signal(sem);
              }];

        [task resume];

        dispatch_time_t timeout =
            dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC);
        if (dispatch_semaphore_wait(sem, timeout) != 0) {
            NSLog(@"[objc-demo] timeout");
            return 2;
        }
    }
    return 0;
}

```
其实我不懂 objc，但是这段也不算太长，我们简单解析一下他在做什么吧。首先使用构建了一个 url string，然后使用`dataTaskWithRequest:request completionHandler` 来做一个结束的时候的回调，总之就是请求了一个网站，打印了返回的结果。接下来我们来看看实际编译的二进制长什么样。打开宇宙第一好用的 ida pro，点击万能f5，
```c
int __fastcall main(int argc, const char **argv, const char **envp)
{
  void *v3; // x19
  dispatch_semaphore_t v4; // x22
  NSURL *v5; // x20
  NSURLRequest *v6; // x21
  NSURLSession *v7; // x24
  dispatch_semaphore_s *v8; // x22
  NSURLSessionDataTask *v9; // x23
  dispatch_time_t v10; // x0
  int v11; // w24
  _QWORD v13[4]; // [xsp+8h] [xbp-58h] BYREF
  id v14; // [xsp+28h] [xbp-38h]

  v3 = objc_autoreleasePoolPush();
  v4 = dispatch_semaphore_create(0);
  v5 = objc_retainAutoreleasedReturnValue(
         +[NSURL URLWithString:](
           &OBJC_CLASS___NSURL,
           "URLWithString:",
           CFSTR("https://httpbin.org/get?source=objc_demo")));
  v6 = objc_retainAutoreleasedReturnValue(+[NSURLRequest requestWithURL:](&OBJC_CLASS___NSURLRequest, "requestWithURL:", v5));
  v7 = objc_retainAutoreleasedReturnValue(+[NSURLSession sharedSession](&OBJC_CLASS___NSURLSession, "sharedSession"));
  v13[0] = _NSConcreteStackBlock;
  v13[1] = 3254779904LL;
  v13[2] = __main_block_invoke;
  v13[3] = &__block_descriptor_40_e8_32s_e46_v32__0__NSData_8__NSURLResponse_16__NSError_24l;
  v8 = objc_retain(v4);
  v14 = v8;
  v9 = objc_retainAutoreleasedReturnValue(-[NSURLSession dataTaskWithRequest:completionHandler:](v7, "dataTaskWithRequest:completionHandler:", v6, v13));
  objc_release(v7);
  -[NSURLSessionDataTask resume](v9, "resume");
  v10 = dispatch_time(0, 12000000000LL);
  if ( dispatch_semaphore_wait(v8, v10) )
  {
    NSLog(&CFSTR("[objc-demo] timeout").isa);
    v11 = 2;
  }
  else
  {
    v11 = 0;
  }
  objc_release(v9);
  objc_release(v14);
  objc_release(v6);
  objc_release(v5);
  objc_release(v8);
  objc_autoreleasePoolPop(v3);
  return v11;
}
```
虽然啥也没 strip，所以确实跟源代码比起来，对于我不会 objc 反而看的更舒服了。我们关注一下这一段。
```c
v13[0] = _NSConcreteStackBlock;
v13[1] = 0xC2000000LL;
v13[2] = __main_block_invoke;
v13[3] = &__block_descriptor_40_e8_32s_e46_v32__0__NSData_8__NSURLResponse_16__NSError_24l;
v8 = objc_retain(v4);
v14 = v8;
v9 = objc_retainAutoreleasedReturnValue(-[NSURLSession dataTaskWithRequest:completionHandler:](v7, "dataTaskWithRequest:completionHandler:", v6, v13));
```
这里其实映射了一个apple 特有的底层模型，具体请参阅：[apple block abi](https://clang.llvm.org/docs/Block-ABI-Apple.html) 。我们使用 rust 来表示这个内存结构
```rs
#[repr(C)]
struct RawBlockLiteral {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: *const c_void,
    descriptor: *const c_void,
}
```
flags 实际上是一个位掩码，表示是否捕获变量，是否有签名信息等。我们可以使用`BLOCK_HAS_COPY_DISPOSE | BLOCK_HAS_SIGNATURE`来表示这个值，reserved如其名没啥用，补 0，而 isa 则是通常指向三个全局类之一：`_NSConcreteStackBlock, _NSConcreteGlobalBlock, _NSConcreteMallocBlock`。 

而剩下两个则是我们这次的核心。闭包肯定需要一个执行的函数，也就是这里的这个 invoke，而 descriptor 则是这个 invoke 函数的函数签名（因为 objc 实际上缺乏运行时的信息，需要额外补充）

我们先来看看这个descriptor，在 ida 里面可以看到
```
__const:0000000100004088 ___block_descriptor_40_e8_32s_e46_v32__0__NSData_8__NSURLResponse_16__NSError_24l DCB    0
__const:0000000100004088                                         ; DATA XREF: _main+A0↑o
__const:0000000100004089                 DCB    0
__const:000000010000408A                 DCB    0
__const:000000010000408B                 DCB    0
__const:000000010000408C                 DCB    0
__const:000000010000408D                 DCB    0
__const:000000010000408E                 DCB    0
__const:000000010000408F                 DCB    0
__const:0000000100004090                 DCB 0x28 ; (
__const:0000000100004091                 DCB    0
__const:0000000100004092                 DCB    0
__const:0000000100004093                 DCB    0
__const:0000000100004094                 DCB    0
__const:0000000100004095                 DCB    0
__const:0000000100004096                 DCB    0
__const:0000000100004097                 DCB    0
__const:0000000100004098                 DCQ ___copy_helper_block_e8_32s
__const:00000001000040A0                 DCQ ___destroy_helper_block_e8_32s
__const:00000001000040A8                 DCQ aV320Nsdata8Nsu     ; "v32@?0@\"NSData\"8@\"NSURLResponse\"16@"...
__const:00000001000040B0                 DCB    0
__const:00000001000040B1                 DCB    1
__const:00000001000040B2                 DCB    0
__const:00000001000040B3                 DCB    0
__const:00000001000040B4                 DCB    0
__const:00000001000040B5                 DCB    0
__const:00000001000040B6                 DCB    0
__const:00000001000040B7                 DCB    0
__const:00000001000040B7 ; __const       ends
```
根据官方文档实际上是
```c
struct Block_descriptor_1 {
    unsigned long int reserved;     // NULL
    unsigned long int size;         // sizeof(struct Block_literal_1)
    // optional helper functions
    void (*copy_helper)(void *dst, void *src);     // IFF (1<<25)
    void (*dispose_helper)(void *src);             // IFF (1<<25)
    // required ABI.2010.3.16
    const char *signature;                         // IFF (1<<30)
} *descriptor;
```
会发现，在 IDA 中 aV320Nsdata8Nsu（signature） 之后还有 8 字节的数据（这实际上是 Extended Layout Info）。这在 ARC 时代用于描述捕获变量的强弱引用关系。也就是提供给运行时查看的内容。我们之后实际上会自己接管这个部分，因此我们并不需要去管这个 layout。使用 rust 表示这个 descriptor 可以这样
```rs
#[repr(C)]
struct BlockDescriptor {
    reserved: usize,
    size: usize,
    copy_helper: extern "C" fn(*mut c_void, *const c_void),
    dispose_helper: extern "C" fn(*const c_void),
    signature: *const c_char,
}
```
这里前三个签名我们都能理解是什么意思，注意 size 是整个 block 的 size 即可。但是最后这个 signature 就很有意思了。
```
aV320Nsdata8Nsu DCB "v32@?0@",0x22,"NSData",0x22,"8@",0x22,"NSURLResponse",0x22,"16@",0x22,NSError",0x22,"24",0
```
这是因为 ida 把双引号当成0x22了。实际上这个字符串是`v32@?0@"NSData"8@"NSURLResponse"16@"NSError"24`。 v32 表示返回值是void， 32代表整个 block 的内存大小，@?表示 self，也就是当前的 block，然后后面跟的 0 是偏移量的意思。后面的 @"NSData"8 就是偏移量为 8 的地方是一个 `NSData`，@"NSURLResponse"16 就是偏移量为 16 有一个 `NSURLResponse`。但是实际上其实给一个`"v@?@@@\0"`就足够了，因为 objc 运行时拿到参数的个数就已经懂得怎么去处理这个内容了。我们看到这么长一坨实际上是编译器自动附加的一些具体类型。

好了 到这里也差不多解析完最复杂的这一块内容了。我们的目标是 hook 这个 objc 程序，然后实现返回值的替换。
```asm
10000089c: aa0003f6     mov     x22, x0
1000008a0: f90017e0     str     x0, [sp, #0x28]
1000008a4: 910023e3     add     x3, sp, #0x8
1000008a8: aa1803e0     mov     x0, x24
1000008ac: aa1503e2     mov     x2, x21
1000008b0: 9400008c     bl      0x100000ae0 <_objc_msgSend$dataTaskWithRequest:completionHandler:>
```
讲了那么多，实际上就是为了这里的替换。我们需要替换掉这个回调——completionHandler。但是我们这里看到一个比较有意思，这个函数的整个签名是
```
_objc_msgSend$dataTaskWithRequest:completionHandler:
```
我们需要了解一下 `_objc_msgSend` 这个函数是什么。平时我们写的 c cpp rust 都会默认将 `x0` 作为返回值，`x0`，`x1` 之类的作为传入函数的第一个，第二个参数。但是这个 `_objc_msgSend` 实际上是直接用汇编完成的，因此可以随意约定，可以随便传参。这个函数的要求就是前俩参数 `x0`, `x1` 固定是 self (block 本身)和 `selector`，而剩下则随意。 就类似于 python 那样可以直接这样理解
```py
msg_send(self, selector, *args)
```
实际上这个函数提供了一个消息的传递机制，而我们在 rust 里面去 ffi 这个函数，需要在每次用到前先将这个函数指定为我们需要的函数签名样式再去调用，例如这样
```rs
type ObjcDataTaskCall =
    unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> *mut c_void;

let data_with_bytes: NsDataWithBytesLenFn = std::mem::transmute(objc_msgSend as *const ());
```

ok，写到这里可以开始我们的 hook 大计了。先将框架写入
```rs
extern "C" fn on_data_task_call(address: u64, ctx: *mut HookContext) {
    unsafe {
        (*ctx).regs.named.x30 = address + 4;
        (*ctx).pc = bridge_data_task_with_request as usize as u64;
    }
}

extern "C" fn init() {
    unsafe {
        let slide = _dyld_get_image_vmaddr_slide(1) as u64;
        ORIGINAL_TARGET = 0x1_0000_0AE0 + slide;
        let callsite = 0x1_0000_08B0 + slide;
        let _ = instrument_no_original(callsite, on_data_task_call);
    }
}

#[used]
#[cfg_attr(
    any(target_os = "macos", target_os = "ios"),
    unsafe(link_section = "__DATA,__mod_init_func")
)]
static INIT_ARRAY: extern "C" fn() = init;
```
这部分比较无趣，可以参照前两次的 blog 看看是什么意思，这里就不再解释了。我们不再执行原始那条指令，因此使用no original 的 api。由于我们需要模拟一个函数调用，因此我们需要让函数知道执行完回到哪里。这里 `x30` 写入了一个当前地址的 next step，可以在执行完 `on_data_task_call` 之后自动回到正确的位置，而 pc 则直接被设置到 `on_data_task_call` 这里，以便直接执行。

不过在开始具体逻辑之前，先演示一下怎么调用其他语言的函数
```rs
use libc::{c_char, c_void};
use sighook::{instrument_no_original, HookContext};
use std::ffi::c_uint;

#[cfg(not(all(target_arch = "aarch64", any(target_os = "macos", target_os = "ios"))))]
compile_error!("rusthook_objc only supports aarch64 Apple targets");

static mut ORIGINAL_TARGET: u64 = 0;

#[link(name = "objc")]
unsafe extern "C" {
    fn _dyld_get_image_vmaddr_slide(image_index: c_uint) -> isize;

    static _NSConcreteStackBlock: c_void;
    fn _Block_copy(block: *const c_void) -> *mut c_void;
    fn _Block_release(block: *const c_void);

    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDataGetLength(the_data: *const c_void) -> isize;
    fn CFDataGetBytePtr(the_data: *const c_void) -> *const u8;
}

type ObjcDataTaskCall =
    unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> *mut c_void;
type CompletionInvokeFn = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void);
type NsDataWithBytesLenFn =
    unsafe extern "C" fn(*mut c_void, *mut c_void, *const u8, usize) -> *mut c_void;
```
在 rs 里面就是这样简单，你只需要写一个 unsafe extern "C" 大部分就可以了（如果默认会 link 的话），如果不会你再补上 link name 即可。如果我们只是想替换原本的返回值其实比较简单，这里我们还顺便需要执行一次原始操作来看看原本会是什么内容，因此我们还导入了 `CFDataGetLength` 等两个函数来获取字符串的值。案例如下
```rs
fn decode_body_preview(data: *mut c_void) -> String {
    unsafe {
        let len = CFDataGetLength(data.cast()) as usize;
        let ptr = CFDataGetBytePtr(data.cast());
        let bytes = std::slice::from_raw_parts(ptr, len);
        String::from_utf8_lossy(bytes).into_owned()
    }
}
```

继续我们 hook 的部分。
```rs
extern "C" fn bridge_data_task_with_request(
    receiver: *mut c_void,
    selector_ptr: *mut c_void,
    request: *mut c_void,
    completion_block: *mut c_void,
) -> *mut c_void {
    unsafe {
        let real: ObjcDataTaskCall = std::mem::transmute(ORIGINAL_TARGET as usize);
        let wrapped = make_completion_replace_block(completion_block);
        let ret = real(receiver, selector_ptr, request, wrapped);
        _Block_release(wrapped.cast());
        ret
    }
}
```
这个函数是 pc 设置的那个函数，模拟了原本的 msg send 入参，我们在这个函数首先拿到原本那个函数的位置（并映射到了他真正的函数签名），这里我们没有直接换掉整个，而是继续保留原本的逻辑，只不过我们将闭包的那个关键 invoke 函数给改了。
```rs
#[repr(C)]
struct CompletionReplaceBlock {
    literal: BlockLiteral,
    original_block: *mut c_void,
}

static mut BLOCK_DESCRIPTOR: BlockDescriptor = BlockDescriptor {
    reserved: 0,
    size: std::mem::size_of::<CompletionReplaceBlock>(),
    copy_helper: completion_block_copy,
    dispose_helper: completion_block_dispose,
    signature: c"v@?@@@".as_ptr(), // keep same with original, described before.
};

fn make_completion_replace_block(original_block: *mut c_void) -> *mut c_void {
    let descriptor = std::ptr::addr_of!(BLOCK_DESCRIPTOR);
    let stack_block = CompletionReplaceBlock {
        literal: BlockLiteral {
            isa: std::ptr::addr_of!(_NSConcreteStackBlock).cast(), // as before, an on stack global class pointer
            flags: (1 << 25) | (1 << 30),
            reserved: 0,
            invoke: completion_replace_invoke as *const c_void, // replaced with our data
            descriptor,
        },
        original_block,
    };
    unsafe { _Block_copy((&stack_block as *const CompletionReplaceBlock).cast()) }
}
```
最后我们需要 `_Block_copy` 将栈上的值转移到堆上（来保留引用计数），否则在整个网络请求的生命周期结束之后就会被自动回收，导致
 `EXC_BAD_ACCESS`，但是这里增加了一次引用计数之后，我们后面还需要手动 release 掉，否则会发生内存泄露。在 `bridge_data_task_with_request` 里面我们手动 release 了一次，是因为这个 release 实际上并不是 free 掉那里的内存，而是减少一次引用计数（因为这里的内存管理 rust 并不能帮我们管，而是 objc 运行时在管理 ）。
 
最后这里的 `flag` 的 `(1 << 25)` 上面说过，`BLOCK_HAS_COPY_DISPOSE`, 也就是说这个 block 需要含有一个 copy 函数和一个 dispose 函数。直接搓一个很简单。
 ```rs
 extern "C" fn completion_block_copy(dst: *mut c_void, src: *const c_void) {
    unsafe {
        let dst_block = dst.cast::<CompletionReplaceBlock>();
        let src_block = src.cast::<CompletionReplaceBlock>();
        
        // increase one auto reference count.
        (*dst_block).original_block = _Block_copy((*src_block).original_block.cast());
    }
}

extern "C" fn completion_block_dispose(src: *const c_void) {
    unsafe {
        let src_block = src.cast::<CompletionReplaceBlock>();
        
        // decrease one auto reference count.
        _Block_release((*src_block).original_block.cast());
    }
}
```

除此之外，block 还可以在literal 后面设置捕获变量，这里实际上的捕获参数就是指代我们新的 block 下面的 original_block。
```rs
extern "C" fn completion_replace_invoke(
    block: *mut c_void,
    data: *mut c_void,
    response: *mut c_void,
    error: *mut c_void,
) {
    eprintln!("[objc-hook] original={}", decode_body_preview(data));
    unsafe {
        // cast the total block (contains our block and original block)
        // to the struct model defined before.
        let wrapper = block.cast::<CompletionReplaceBlock>();
        
        // get the original block's invoke pointer.
        let invoke_ptr = (*((*wrapper).original_block.cast::<RawBlockLiteral>())).invoke;
        let invoke: CompletionInvokeFn = std::mem::transmute(invoke_ptr);

        // build a objc's string.
        let nsdata_cls = objc_getClass(c"NSData".as_ptr());
        let data_with_bytes: NsDataWithBytesLenFn = std::mem::transmute(objc_msgSend as *const ());
        let hook_json_data = data_with_bytes(
            nsdata_cls,
            sel_registerName(c"dataWithBytes:length:".as_ptr()),
            br#"{"hooked": true}"#.as_ptr(),
            br#"{"hooked": true}"#.len(),
        );
        
        // use original block's invoke with replaced data.
        // NOTICE: this function is called after whole network action.
        // so it will be called with response text.
        // Now we replace it with hooked json data (we build just now.) 
        invoke((*wrapper).original_block, hook_json_data, response, error);
    }
}
```
注意这个函数的执行时机。这个函数并不是在我们 hook 的时候执行的，我们 hook 的时候是定义了这个函数，并将这个函数指针作为 invoke 函数，等回到正经的回调逻辑执行的时候才执行的这个函数。

---

梳理一下我们的 hook 逻辑。我们实际上在 msg send 之前将整个执行函数换成我们的函数，但是我们在自己的函数里面调用了原本的内容（并做了一层包装）。我们将原本的那个 block 给当成一个新的捕获参数，目的是在执行到替换后的回调函数的时候，我们再从内存中取出原本的 original block，再将我们的 replace 内容给作为入参去执行。

来看看执行效果
```sh
$ ./objc/build/objc_demo

2026-03-12 08:29:15.479 objc_demo[38761:5244237] [objc-demo] status=200 error=(null)
2026-03-12 08:29:15.480 objc_demo[38761:5244237] [objc-demo] body={
  "args": {
    "source": "objc_demo"
  },
  "headers": {
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "Host": "httpbin.org",
    "Priority": "u=3",
    "User-Agent": "objc_demo (unknown version) CFNetwork/3860.400.51 Darwin/25.3.0",
    "X-Amzn-Trace-Id": "Root=1-69b208db-217eb7d048c79d254bc66946"
  },
  "origin": "45.135.228.64",
  "url": "https://httpbin.org/get?source=objc_demo"
}

$ DYLD_INSERT_LIBRARIES=target/release/librusthook_objc.dylib ./objc/build/objc_demo

[objc-hook] original={
  "args": {
    "source": "objc_demo"
  },
  "headers": {
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "Host": "httpbin.org",
    "Priority": "u=3",
    "User-Agent": "objc_demo (unknown version) CFNetwork/3860.400.51 Darwin/25.3.0",
    "X-Amzn-Trace-Id": "Root=1-69b19eaa-458c4beb3a4aa38b3dc2472d"
  },
  "origin": "45.135.228.64",
  "url": "https://httpbin.org/get?source=objc_demo"
}

2026-03-12 00:56:10.336 objc_demo[24947:5052351] [objc-demo] status=200 error=(null)
2026-03-12 00:56:10.336 objc_demo[24947:5052351] [objc-demo] body={"hooked": true}
```

---

## swift relative 
这里我们的 swift 就不重新写一份 rust 的 hook（实际上我是写了的）。我们先进行一些简单的分析。受害者如下
```swift
import Foundation

let sem = DispatchSemaphore(value: 0)

let url = URL(string: "https://httpbin.org/get?source=swift_demo")!
let task = URLSession.shared.dataTask(with: url) { data, response, error in
    let status = (response as? HTTPURLResponse)?.statusCode ?? -1
    print("[swift-demo] status=\(status) error=\(String(describing: error))")

    if let data {
        let body = String(data: data, encoding: .utf8) ?? "<non-utf8 \(data.count) bytes>"
        print("[swift-demo] body=\(body)")
    }

    sem.signal()
}

task.resume()
let timeout = DispatchTime.now() + .seconds(12)
if sem.wait(timeout: timeout) == .timedOut {
    print("[swift-demo] timeout")
    exit(2)
}
```
将二进制放入 ida 就会发现
```c
URL._bridgeToObjectiveC()(v14);
v16 = v15;
(*(void (__fastcall **)(char *, __int64))(v9 + 8))(v10, v8);
aBlock[4] = closure #1 in ;
aBlock[5] = 0;
aBlock[0] = _NSConcreteStackBlock;
aBlock[1] = 1107296256;
aBlock[2] = thunk for @escaping @callee_guaranteed @Sendable (@guaranteed Data?, @guaranteed NSURLResponse?, @guaranteed Error?) -> ();
aBlock[3] = &block_descriptor;
v17 = _Block_copy(aBlock);
v18 = (objc_class *)objc_retainAutoreleasedReturnValue(objc_msgSend(v13, "dataTaskWithURL:completionHandler:", v16, v17));
_Block_release(v17);
objc_release(v13);
objc_release(v16);
task.super.super.isa = v18;
-[objc_class resume](v18, "resume");
```
核心区逻辑实际上是一样的。事实上 swift 在这里会将整个函数包装为一个 objc 对象，以闭包的形式调用。因此我们上面 objc 的方法甚至可以一字不变的使用，只需要将偏移量改一下，整个程序都能复用。

---

## 关于为什么，为什么，为什么
关于安全性的事情。这里用了超级多的 unsafe，除了包括内存管理这种外部的东西，我们还需要保证例如原子性... etc., 但是这里实在是过于简单的一个案例了，尤其是在单线程情况下，我们还是在触发异常的情况下在程序已经断下来的时候进行处理，所以我直接全局 `static mut` 不但简单而且也不至于竞争，因此也无可厚非。

> 请确保你有授权可以做下面的事情！
以及为什么要在网络返回值这里 hook？比如说一个软件从服务器会返回一段 license json，然后你想要干点坏事的话，你在内存去伪造一块合理的 license 找到伪装点反而还挺困难的，因为这个 license 的结构可能很难模拟，又或者你根本就无法从正常的逻辑正确的走到构建出 license object 的阶段（而这个 license 本身需要用来在 ui 上显示出你的信息，还不可能不去 mock 一个，否则 ui 会读到无效值导致 panic）。 比如原始 json 返回的是 `{"auth": false, "error": "abcddddd"}` 那么根本就没法走到 parse 其他内容的逻辑，到 auth 那里的判断就 fast exit，走到错误处理的逻辑了。

除此之外，我们为什么选择instrument，不是 method swizzling，其实这里也有一个考虑。比如说这个函数本身很长，我们并不想真的去重写整个函数，我们可能只是想要换掉其中一点点逻辑，做一点关键的 patch，这个时候使用 instrument 可以实现指令级别的 patch 和入口绕行，这显然也很合适。
