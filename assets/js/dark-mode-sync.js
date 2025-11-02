// assets/js/dark-mode-sync.js
(function () {
    // 检查 localStorage 中是否已经有用户的手动设置
    const theme = localStorage.getItem("theme");
    const htmlEl = document.documentElement;

    // 如果用户没有手动选择过主题
    if (!theme) {
        // 使用 'prefers-color-scheme' 来检测系统设置
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

        // 定义一个函数来更新主题
        function updateTheme(isDark) {
            if (isDark) {
                htmlEl.classList.add("dark");
                // 可选：同时更新 localStorage，让主题选择被“记住”
                localStorage.setItem("theme", "dark");
            } else {
                htmlEl.classList.remove("dark");
                localStorage.setItem("theme", "light");
            }
        }

        // 首次加载时，根据系统设置应用主题
        updateTheme(prefersDark.matches);

        // 监听系统颜色模式的变化，并实时同步
        prefersDark.addEventListener("change", (e) => {
            updateTheme(e.matches);
        });
    }
})();
