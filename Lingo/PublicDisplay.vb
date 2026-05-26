Public Class PublicDisplay

    Private Sub PublicDisplay_Load(sender As Object, e As EventArgs) Handles MyBase.Load
        PictureBox1.Size = Me.Size
    End Sub

    Private Sub PublicDisplay_Move(sender As Object, e As EventArgs) Handles Me.Move
        Me.Size = Screen.FromControl(Me).Bounds.Size
    End Sub
End Class