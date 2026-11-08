#include <jni.h>
#include <string>
#include <vector>
#include <cstdlib>
#include <cstring>
#include "node.h"

extern "C" JNIEXPORT void JNICALL
Java_com_quasar_mobile_NativeNode_setEnv(JNIEnv* env, jclass, jstring k, jstring v) {
    const char* ck = env->GetStringUTFChars(k, nullptr);
    const char* cv = env->GetStringUTFChars(v, nullptr);
    setenv(ck, cv, 1);
    env->ReleaseStringUTFChars(k, ck);
    env->ReleaseStringUTFChars(v, cv);
}

// Запуск Node в этом потоке (возвращает код выхода, когда Node завершится). Аргументы должны лежать одним куском памяти.
extern "C" JNIEXPORT jint JNICALL
Java_com_quasar_mobile_NativeNode_startNode(JNIEnv* env, jclass, jobjectArray arguments) {
    int argc = env->GetArrayLength(arguments);
    std::vector<std::string> a;
    size_t total = 0;
    for (int i = 0; i < argc; i++) {
        jstring s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char* c = env->GetStringUTFChars(s, nullptr);
        a.emplace_back(c);
        total += strlen(c) + 1;
        env->ReleaseStringUTFChars(s, c);
    }
    char* buf = (char*) calloc(total + 1, sizeof(char));
    char** argv = (char**) calloc(argc + 1, sizeof(char*));
    char* cur = buf;
    for (int i = 0; i < argc; i++) {
        memcpy(cur, a[i].c_str(), a[i].size() + 1);
        argv[i] = cur;
        cur += a[i].size() + 1;
    }
    return jint(node::Start(argc, argv));
}
