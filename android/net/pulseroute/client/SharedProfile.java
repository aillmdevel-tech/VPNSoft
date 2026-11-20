package net.pulseroute.client;

import android.content.*;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;
import java.util.UUID;

public final class SharedProfile extends ContentProvider {
    static File fresh(Context context) throws IOException {
        return fresh(context,".zip");
    }
    static File fresh(Context context,String extension) throws IOException {
        File dir = new File(context.getCacheDir(),"shared-profiles");
        if (!dir.isDirectory() && !dir.mkdir()) throw new IOException();
        File[] old = dir.listFiles();
        if (old != null) for (File f : old)
            if (System.currentTimeMillis()-f.lastModified()>86400000L) f.delete();
        return new File(dir,UUID.randomUUID()+extension);
    }
    private File file(Uri uri) {
        String name=uri.getLastPathSegment();
        if(name==null || !name.matches("[a-f0-9-]{36}\\.(zip|png)") || uri.getPathSegments().size()!=1)
            throw new IllegalArgumentException();
        return new File(new File(getContext().getCacheDir(),"shared-profiles"),name);
    }
    public boolean onCreate(){return true;}
    public String getType(Uri uri){return file(uri).getName().endsWith(".png")?"image/png":"application/zip";}
    public ParcelFileDescriptor openFile(Uri uri,String mode) throws FileNotFoundException {
        if(!"r".equals(mode))throw new FileNotFoundException();
        return ParcelFileDescriptor.open(file(uri),ParcelFileDescriptor.MODE_READ_ONLY);
    }
    public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){
        File f=file(uri);
        String[] cols=projection!=null?projection:new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE};
        MatrixCursor cursor=new MatrixCursor(cols);
        Object[] row=new Object[cols.length];
        for(int i=0;i<cols.length;i++){
            if(OpenableColumns.DISPLAY_NAME.equals(cols[i]))row[i]=f.getName().endsWith(".png")?"Route-QR.png":"Route-profiles.zip";
            if(OpenableColumns.SIZE.equals(cols[i]))row[i]=f.length();
        }
        cursor.addRow(row);return cursor;
    }
    public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}
    public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException();}
    public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}
}
