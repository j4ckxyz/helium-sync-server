// Package crx builds signed CRX3 extension packages.
//
// Format (see Chromium components/crx_file):
//
//	"Cr24" | uint32le(3) | uint32le(len(header)) | header | zip
//
// header is a serialized CrxFileHeader protobuf:
//
//	message CrxFileHeader {
//	  repeated AsymmetricKeyProof sha256_with_rsa = 2;
//	  bytes signed_header_data = 10000;  // serialized SignedData
//	}
//	message AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
//	message SignedData { bytes crx_id = 1; }
//
// The signature covers "CRX3 SignedData\x00" | uint32le(len(signed_header_data))
// | signed_header_data | zip.
package crx

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
)

// LoadOrCreateKey reads a PEM RSA private key from path, generating and saving
// a new 2048-bit key if the file does not exist.
func LoadOrCreateKey(path string) (*rsa.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		blk, _ := pem.Decode(b)
		if blk == nil {
			return nil, errors.New("crx: invalid PEM key file")
		}
		k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if err != nil {
			return nil, err
		}
		rk, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("crx: key is not RSA")
		}
		return rk, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return k, nil
}

// PublicKeyDER returns the SubjectPublicKeyInfo encoding used by Chromium.
func PublicKeyDER(k *rsa.PrivateKey) []byte {
	der, err := x509.MarshalPKIXPublicKey(&k.PublicKey)
	if err != nil {
		panic(err) // cannot fail for a valid RSA key
	}
	return der
}

// ManifestKey is the value for the manifest "key" field, which pins the
// extension ID when the extension is loaded unpacked.
func ManifestKey(k *rsa.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(PublicKeyDER(k))
}

func crxID(pub []byte) []byte {
	h := sha256.Sum256(pub)
	return h[:16]
}

// ExtensionID returns the Chromium extension ID (a-p encoded) for the key.
func ExtensionID(k *rsa.PrivateKey) string {
	id := crxID(PublicKeyDER(k))
	out := make([]byte, 0, 32)
	for _, b := range id {
		out = append(out, 'a'+(b>>4), 'a'+(b&0xf))
	}
	return string(out)
}

// Build signs zip and returns a CRX3 package.
func Build(k *rsa.PrivateKey, zip []byte) ([]byte, error) {
	pub := PublicKeyDER(k)
	signedData := pbBytes(nil, 1, crxID(pub))

	h := sha256.New()
	h.Write([]byte("CRX3 SignedData\x00"))
	var n [4]byte
	binary.LittleEndian.PutUint32(n[:], uint32(len(signedData)))
	h.Write(n[:])
	h.Write(signedData)
	h.Write(zip)
	sig, err := rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, h.Sum(nil))
	if err != nil {
		return nil, fmt.Errorf("crx: sign: %w", err)
	}

	proof := pbBytes(pbBytes(nil, 1, pub), 2, sig)
	header := pbBytes(nil, 2, proof)
	header = pbBytes(header, 10000, signedData)

	out := make([]byte, 0, 12+len(header)+len(zip))
	out = append(out, "Cr24"...)
	out = binary.LittleEndian.AppendUint32(out, 3)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(header)))
	out = append(out, header...)
	out = append(out, zip...)
	return out, nil
}

// pbBytes appends a length-delimited protobuf field.
func pbBytes(b []byte, field int, v []byte) []byte {
	b = binary.AppendUvarint(b, uint64(field)<<3|2)
	b = binary.AppendUvarint(b, uint64(len(v)))
	return append(b, v...)
}

// Verify checks a CRX3 package's structure and RSA signature and returns the
// embedded zip and extension ID. It is used by tests and as a self-check
// before serving a package.
func Verify(crx []byte) (zip []byte, id string, err error) {
	if len(crx) < 12 || string(crx[:4]) != "Cr24" || binary.LittleEndian.Uint32(crx[4:]) != 3 {
		return nil, "", errors.New("crx: bad magic or version")
	}
	hl := int(binary.LittleEndian.Uint32(crx[8:]))
	if 12+hl > len(crx) {
		return nil, "", errors.New("crx: truncated header")
	}
	header, zip := crx[12:12+hl], crx[12+hl:]
	fields, err := pbParse(header)
	if err != nil {
		return nil, "", err
	}
	signedData := fields[10000]
	if len(signedData) != 1 {
		return nil, "", errors.New("crx: missing signed header data")
	}
	sd, err := pbParse(signedData[0])
	if err != nil || len(sd[1]) != 1 {
		return nil, "", errors.New("crx: bad signed data")
	}
	wantID := sd[1][0]
	for _, p := range fields[2] {
		pf, err := pbParse(p)
		if err != nil || len(pf[1]) != 1 || len(pf[2]) != 1 {
			continue
		}
		pub, sig := pf[1][0], pf[2][0]
		if string(crxID(pub)) != string(wantID) {
			continue
		}
		pk, err := x509.ParsePKIXPublicKey(pub)
		if err != nil {
			continue
		}
		rk, ok := pk.(*rsa.PublicKey)
		if !ok {
			continue
		}
		h := sha256.New()
		h.Write([]byte("CRX3 SignedData\x00"))
		var n [4]byte
		binary.LittleEndian.PutUint32(n[:], uint32(len(signedData[0])))
		h.Write(n[:])
		h.Write(signedData[0])
		h.Write(zip)
		if rsa.VerifyPKCS1v15(rk, crypto.SHA256, h.Sum(nil), sig) == nil {
			out := make([]byte, 0, 32)
			for _, b := range wantID {
				out = append(out, 'a'+(b>>4), 'a'+(b&0xf))
			}
			return zip, string(out), nil
		}
	}
	return nil, "", errors.New("crx: no valid signature for crx id")
}

func pbParse(b []byte) (map[int][][]byte, error) {
	out := map[int][][]byte{}
	for len(b) > 0 {
		tag, n := binary.Uvarint(b)
		if n <= 0 {
			return nil, errors.New("crx: bad protobuf tag")
		}
		b = b[n:]
		if tag&7 != 2 {
			return nil, errors.New("crx: unexpected wire type")
		}
		l, n := binary.Uvarint(b)
		if n <= 0 || uint64(len(b)-n) < l {
			return nil, errors.New("crx: bad protobuf length")
		}
		b = b[n:]
		out[int(tag>>3)] = append(out[int(tag>>3)], b[:l])
		b = b[l:]
	}
	return out, nil
}
