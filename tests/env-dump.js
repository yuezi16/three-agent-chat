// T-025 测试用探针：把宿主交给子进程的环境变量原样打印出来（纯 ASCII，走 Node 自己的 stdout 写入）。
// 用它替代 .cmd 探针——cmd.exe 在本机对 .cmd 有编码/引号怪癖，Node 没有。
process.stdout.write('HTTP_PROXY=[' + (process.env.HTTP_PROXY ?? '') + ']\n');
process.stdout.write('HTTPS_PROXY=[' + (process.env.HTTPS_PROXY ?? '') + ']\n');
process.stdout.write('NO_PROXY=[' + (process.env.NO_PROXY ?? '') + ']\n');
// 不调用 process.exit()：管道还没冲完就退出会截断 stdout（本机实测：探针收不到任何字）。
