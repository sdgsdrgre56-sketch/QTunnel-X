package com.qtunnelx.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.widget.*

class MainActivity : Activity() {
    private lateinit var store: ConfigStore
    private lateinit var server: EditText; private lateinit var port: EditText; private lateinit var user: EditText
    private lateinit var pass: EditText; private lateinit var ip: EditText; private lateinit var dns: EditText
    private lateinit var uploadLimit: EditText; private lateinit var downloadLimit: EditText
    private lateinit var status: TextView; private lateinit var profilesBox: LinearLayout
    private val hashFields = mutableListOf<EditText>()
    private var profiles = mutableListOf<SavedProfile>()
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); store = ConfigStore(this); profiles = store.profiles()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 77)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 24, 28, 36) }
        val scroll = ScrollView(this).apply { addView(root) }; setContentView(scroll)
        root.addView(TextView(this).apply { text="QTunnel X"; textSize=30f; setTypeface(typeface, Typeface.BOLD) })
        root.addView(TextView(this).apply { text="Encrypted Android tunnel • v0.4"; alpha=.7f })
        title(root,"Подключение")
        val c=store.load(); server=field(root,"Сервер / IP",c.server); port=field(root,"UDP порт",c.port.toString())
        user=field(root,"Логин",c.username); pass=field(root,"Пароль",c.password,true)
        ip=field(root,"IP клиента",c.clientIp); dns=field(root,"DNS",c.dns)
        uploadLimit=field(root,"Лимит ↑ Мбит/с (0 = без лимита)",formatLimit(c.uploadMbps))
        downloadLimit=field(root,"Лимит ↓ Мбит/с (0 = без лимита)",formatLimit(c.downloadMbps))
        button(root,"СОХРАНИТЬ") { saveCurrent(); toast("Сохранено") }

        status=TextView(this).apply { textSize=17f; setPadding(0,18,0,8) }; root.addView(status)
        button(root,"ПОДКЛЮЧИТЬ") { saveCurrent(); requestVpn() }
        button(root,"ОТКЛЮЧИТЬ") { startService(Intent(this,QTunnelVpnService::class.java).setAction(QTunnelVpnService.ACTION_STOP)) }

        title(root,"Профили клиентов")
        profilesBox=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL }; root.addView(profilesBox); renderProfiles()
        button(root,"+ СОХРАНИТЬ ТЕКУЩИЙ КАК ПРОФИЛЬ") { askProfileName() }
        button(root,"КОМАНДА ДЛЯ ДОБАВЛЕНИЯ НА VPS") { copyServerUserCommand() }
        button(root,"КОМАНДА ИЗМЕНИТЬ СКОРОСТЬ НА VPS") { copySpeedCommand() }

        title(root,"Хэши / токены")
        root.addView(TextView(this).apply { text="10 локальных слотов. Они сохраняются в приложении, но не используются для имитации звонка VK."; alpha=.72f })
        val hs=store.hashes(); repeat(10){ i -> hashFields += field(root,"Хэш ${i+1}",hs[i]) }
        button(root,"СОХРАНИТЬ ХЭШИ") { store.saveHashes(hashFields.map{it.text.toString()}); toast("Хэши сохранены") }

        handler.post(object:Runnable{ override fun run(){
            val tx=QTunnelVpnService.txBytes.get()/1024; val rx=QTunnelVpnService.rxBytes.get()/1024
            val p=if(QTunnelVpnService.pingMs>=0) "${QTunnelVpnService.pingMs} ms" else "—"
            status.text="${QTunnelVpnService.status}\nPing: $p   ↑ ${tx} KB   ↓ ${rx} KB"
            handler.postDelayed(this,1000)
        }})
    }

    private fun current()=TunnelConfig(
        server.text.toString().trim(),
        port.text.toString().toIntOrNull()?:46000,
        user.text.toString().trim(),
        pass.text.toString(),
        ip.text.toString().trim(),
        dns.text.toString().trim(),
        uploadLimit.text.toString().replace(',', '.').toDoubleOrNull()?.coerceAtLeast(0.0) ?: 0.0,
        downloadLimit.text.toString().replace(',', '.').toDoubleOrNull()?.coerceAtLeast(0.0) ?: 0.0
    )
    private fun saveCurrent()=store.save(current())
    private fun load(c:TunnelConfig){ server.setText(c.server);port.setText(c.port.toString());user.setText(c.username);pass.setText(c.password);ip.setText(c.clientIp);dns.setText(c.dns);uploadLimit.setText(formatLimit(c.uploadMbps));downloadLimit.setText(formatLimit(c.downloadMbps));saveCurrent() }
    private fun formatLimit(v:Double)=if(v<=0.0) "0" else if(v%1.0==0.0) v.toInt().toString() else v.toString()

    private fun requestVpn(){ val i=VpnService.prepare(this); if(i!=null) startActivityForResult(i,1001) else startTunnel() }
    @Deprecated("legacy result API") override fun onActivityResult(r:Int,result:Int,data:Intent?){ super.onActivityResult(r,result,data); if(r==1001&&result==RESULT_OK) startTunnel() }
    private fun startTunnel(){ val i=Intent(this,QTunnelVpnService::class.java).setAction(QTunnelVpnService.ACTION_START); if(Build.VERSION.SDK_INT>=26) startForegroundService(i) else startService(i) }

    private fun copyServerUserCommand(){
        val c=current()
        if(c.username.isBlank() || c.password.isBlank()) { toast("Сначала укажи логин и пароль"); return }
        val cmd="sudo qtunnelx-server user-add -username '${c.username.replace("'","")}' -password '${c.password.replace("'","")}' -ip ${c.clientIp} -upload-mbps ${formatLimit(c.uploadMbps)} -download-mbps ${formatLimit(c.downloadMbps)}"
        val cm=getSystemService(android.content.ClipboardManager::class.java)
        cm.setPrimaryClip(android.content.ClipData.newPlainText("QTunnel X user-add",cmd))
        AlertDialog.Builder(this).setTitle("Команда для VPS").setMessage(cmd+"\n\nЛимиты задаются на сервере и клиент не может изменить их сам. После изменения перезапусти сервер: sudo systemctl restart qtunnelx").setPositiveButton("OK",null).show()
    }

    private fun copySpeedCommand(){
        val c=current()
        if(c.username.isBlank()) { toast("Сначала укажи логин"); return }
        val cmd="sudo qtunnelx-server user-speed -username '${c.username.replace("'","")}' -upload-mbps ${formatLimit(c.uploadMbps)} -download-mbps ${formatLimit(c.downloadMbps)} && sudo systemctl restart qtunnelx"
        val cm=getSystemService(android.content.ClipboardManager::class.java)
        cm.setPrimaryClip(android.content.ClipData.newPlainText("QTunnel X user-speed",cmd))
        AlertDialog.Builder(this).setTitle("Изменение скорости").setMessage(cmd+"\n\nКоманда скопирована. 0 = без ограничения.").setPositiveButton("OK",null).show()
    }

    private fun askProfileName(){ val e=EditText(this).apply{hint="Например: Телефон 1"}; AlertDialog.Builder(this).setTitle("Имя клиента").setView(e).setPositiveButton("Сохранить"){_,_-> val n=e.text.toString().trim(); if(n.isNotEmpty()){profiles.add(SavedProfile(n,current()));store.saveProfiles(profiles);renderProfiles()} }.setNegativeButton("Отмена",null).show() }
    private fun renderProfiles(){ profilesBox.removeAllViews(); if(profiles.isEmpty()) profilesBox.addView(TextView(this).apply{text="Нет сохранённых клиентов";alpha=.6f}) else profiles.forEachIndexed{idx,p->
        val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
        row.addView(Button(this).apply{text="${p.name}\n${p.config.username} • ${p.config.clientIp}"; layoutParams=LinearLayout.LayoutParams(0,-2,1f); setOnClickListener{load(p.config)}})
        row.addView(Button(this).apply{text="×";setOnClickListener{profiles.removeAt(idx);store.saveProfiles(profiles);renderProfiles()}}); profilesBox.addView(row)
    }}

    private fun title(p:LinearLayout,s:String){p.addView(TextView(this).apply{text=s;textSize=20f;setTypeface(typeface,Typeface.BOLD);setPadding(0,24,0,8)})}
    private fun field(p:LinearLayout,h:String,v:String,password:Boolean=false):EditText{ val e=EditText(this).apply{hint=h;setText(v);setSingleLine(true);if(password)inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD};p.addView(e);return e }
    private fun button(p:LinearLayout,t:String,f:()->Unit){p.addView(Button(this).apply{text=t;setOnClickListener{f()}})}
    private fun toast(s:String)=Toast.makeText(this,s,Toast.LENGTH_SHORT).show()
}
